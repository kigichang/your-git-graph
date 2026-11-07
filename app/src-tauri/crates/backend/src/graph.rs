//! The lanes of the commit graph: which column each commit's node sits in, and the lines
//! between the rows. The engine hands over the commits in display order with their parents;
//! this assigns the columns. The front end only draws.
//!
//! One pass over the rows, top to bottom. A lane is a column that is waiting for a commit (the
//! parent some earlier row named). At each row:
//!
//! 1. The lanes waiting for this commit are its *incoming* lanes. The node takes the leftmost
//!    of them (or, for a commit nothing waits for - the tip of a branch - the leftmost free
//!    column, with a new colour); the other incoming lanes end here, each with a line into the
//!    node.
//! 2. The first parent inherits the node's lane. Every other parent gets a line out of the
//!    node: to the lane already waiting for that parent, or to a new lane in the leftmost
//!    free column (a new colour).
//! 3. A parent that is not among the rows gets no lane when nothing more can be loaded
//!    (`connect_missing` false): its line fades out below the node. While more rows can
//!    come, the lane runs on to the bottom and joins up after the next load.
//!
//! Columns are reused as soon as they are free and never shift, so the rows above are the
//! same whatever is loaded below them ([`layout`] of a longer list begins with the layout of
//! the shorter one). Colours are numbers the front end maps onto its palette.
//!
//! The lines come out as *spans*: one per stretch a lane is occupied, from the node it starts
//! at to the node it ends at (or the bottom). A span is six numbers, however many rows it
//! crosses, so a long history with many lanes stays small (a line per row and lane did not:
//! 86 000 rows with 100 lanes made 35 million numbers).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// More lanes than this and the remaining parents fade out instead: a filtered history can
/// leave every row's parents out of the list.
pub const MAX_LANES: usize = 200;

/// Numbers per span in [`Layout::spans`].
pub const SPAN: usize = 6;
/// Numbers per entry in [`Layout::dangling`].
pub const DANGLING: usize = 3;

/// The layout of a list of rows, as flat arrays.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../../web/src/lib/api/generated/")]
pub struct Layout {
    /// How many columns the graph needs.
    pub lanes: u16,
    /// Per row: the column of its node.
    pub node_lane: Vec<u16>,
    /// Per row: the colour of its node (and of the lane it is on).
    pub node_colour: Vec<u16>,
    /// The lines, six numbers each, sorted by their first row: `start` row, `end` row, lane,
    /// `from` lane, `to` lane, colour. The line leaves the node of row `start` (at column
    /// `from`), runs down column `lane`, and reaches the node of row `end` at column `to`.
    /// `end == rows` means it runs off the bottom (its commit is not loaded yet); `to` is then
    /// the lane itself. `start == end` (a lane given up at once) draws nothing.
    pub spans: Vec<u32>,
    /// Lines that fade out below a node, three numbers each: row, lane, colour (a parent
    /// that is not loaded and cannot be).
    pub dangling: Vec<u32>,
}

/// One row's input: the commit and its parents.
pub struct Row<'a> {
    pub hash: &'a str,
    pub parents: &'a [String],
}

struct Lane<'a> {
    /// The row this lane waits for; `None` for a hash that is not among the rows.
    waiting_for: Option<usize>,
    missing: Option<&'a str>,
    colour: u16,
    start: usize,
    from: usize,
}

struct Builder<'a> {
    lanes: Vec<Option<Lane<'a>>>,
    /// Which lanes wait for the row at this index.
    waiting: Vec<Vec<usize>>,
    /// Lanes waiting for a hash that is not among the rows (only with `connect_missing`).
    waiting_missing: HashMap<&'a str, usize>,
    next_colour: u16,
    most_lanes: usize,
    out: Layout,
}

impl<'a> Builder<'a> {
    fn free_lane(&mut self) -> Option<usize> {
        match self.lanes.iter().position(Option::is_none) {
            Some(i) => Some(i),
            None if self.lanes.len() < MAX_LANES => {
                self.lanes.push(None);
                Some(self.lanes.len() - 1)
            }
            None => None,
        }
    }

    fn new_colour(&mut self) -> u16 {
        let c = self.next_colour;
        self.next_colour = self.next_colour.wrapping_add(1);
        c
    }

    fn colour_of(&self, lane: usize) -> u16 {
        self.lanes[lane].as_ref().map_or(0, |l| l.colour)
    }

    fn occupy(&mut self, lane: usize, waiting_for: Option<usize>, missing: Option<&'a str>, colour: u16, start: usize, from: usize) {
        self.lanes[lane] = Some(Lane { waiting_for, missing, colour, start, from });
        match (waiting_for, missing) {
            (Some(row), _) => self.waiting[row].push(lane),
            (None, Some(hash)) => {
                self.waiting_missing.insert(hash, lane);
            }
            (None, None) => {}
        }
        self.most_lanes = self.most_lanes.max(lane + 1);
    }

    /// The lane's line ends at row `end`, in column `to`.
    fn release(&mut self, lane: usize, end: usize, to: usize) {
        if let Some(l) = self.lanes[lane].take() {
            if let Some(row) = l.waiting_for {
                self.waiting[row].retain(|&x| x != lane);
            }
            if let Some(hash) = l.missing {
                self.waiting_missing.remove(hash);
            }
            self.out.spans.extend_from_slice(&[l.start as u32, end as u32, lane as u32, l.from as u32, to as u32, l.colour as u32]);
        }
    }

    fn dangling(&mut self, row: usize, lane: usize, colour: u16) {
        let entry = [row as u32, lane as u32, colour as u32];
        if !self.out.dangling.ends_with(&entry) {
            self.out.dangling.extend_from_slice(&entry);
        }
    }
}

/// Lay out `rows` (display order: a commit before its parents). `connect_missing`: a parent that
/// is not among the rows is still given a lane, because more rows can be loaded below.
pub fn layout(rows: &[Row<'_>], connect_missing: bool) -> Layout {
    let index: HashMap<&str, usize> = rows.iter().enumerate().map(|(i, r)| (r.hash, i)).collect();
    let mut b = Builder {
        lanes: Vec::new(),
        waiting: vec![Vec::new(); rows.len()],
        waiting_missing: HashMap::new(),
        next_colour: 0,
        most_lanes: 0,
        out: Layout::default(),
    };
    b.out.node_lane.reserve(rows.len());
    b.out.node_colour.reserve(rows.len());

    for (i, row) in rows.iter().enumerate() {
        // 1. The node: the leftmost incoming lane, or a new one.
        let mut incoming = std::mem::take(&mut b.waiting[i]);
        incoming.sort_unstable();
        let (node_lane, colour) = match incoming.first() {
            Some(&lane) => (lane, b.colour_of(lane)),
            None => {
                let colour = b.new_colour();
                let lane = match b.free_lane() {
                    Some(lane) => lane,
                    None => {
                        // Every column is taken by a lane running to the bottom: the rightmost
                        // gives way (its line stops at the row above).
                        b.release(MAX_LANES - 1, i.saturating_sub(1), MAX_LANES - 1);
                        MAX_LANES - 1
                    }
                };
                b.most_lanes = b.most_lanes.max(lane + 1);
                (lane, colour)
            }
        };
        for &lane in &incoming {
            b.release(lane, i, node_lane);
        }
        b.out.node_lane.push(node_lane as u16);
        b.out.node_colour.push(colour);

        // 2. The parents: the first keeps the node's lane; the others branch out.
        let mut seen: HashSet<&str> = HashSet::new();
        let mut first = true;
        for parent in row.parents.iter().map(String::as_str).filter(|p| seen.insert(p)) {
            let target = index.get(parent).copied();
            if first {
                first = false;
                match target {
                    Some(t) => b.occupy(node_lane, Some(t), None, colour, i, node_lane),
                    None if connect_missing => b.occupy(node_lane, None, Some(parent), colour, i, node_lane),
                    None => b.dangling(i, node_lane, colour),
                }
                continue;
            }
            // A lane already waiting for this parent: join it.
            let waiting = match target {
                Some(t) => b.waiting[t].iter().copied().min(),
                None => b.waiting_missing.get(parent).copied(),
            };
            if let Some(lane) = waiting {
                // A line of its own from this node to that lane, which goes on waiting.
                let c = b.colour_of(lane);
                b.out.spans.extend_from_slice(&[i as u32, i as u32 + 1, lane as u32, node_lane as u32, lane as u32, c as u32]);
                continue;
            }
            if target.is_none() && !connect_missing {
                b.dangling(i, node_lane, colour);
                continue;
            }
            match b.free_lane() {
                Some(lane) => {
                    let c = b.new_colour();
                    b.occupy(lane, target, if target.is_none() { Some(parent) } else { None }, c, i, node_lane);
                }
                None => b.dangling(i, node_lane, colour),
            }
        }
        // Columns at the right that are free again are given back.
        while matches!(b.lanes.last(), Some(None)) {
            b.lanes.pop();
        }
    }
    // The lanes still waiting run off the bottom.
    for lane in 0..b.lanes.len() {
        b.release(lane, rows.len(), lane);
    }
    b.out.lanes = b.most_lanes as u16;
    sort_spans(&mut b.out.spans);
    b.out
}

/// Spans by their first row (the order among those of one row does not matter).
fn sort_spans(spans: &mut Vec<u32>) {
    let mut order: Vec<[u32; SPAN]> = spans.chunks(SPAN).map(|s| [s[0], s[1], s[2], s[3], s[4], s[5]]).collect();
    order.sort_unstable_by_key(|s| s[0]);
    spans.clear();
    for s in order {
        spans.extend_from_slice(&s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rows from "hash parent parent" lines.
    fn rows(spec: &[&str]) -> Vec<(String, Vec<String>)> {
        spec.iter()
            .map(|line| {
                let mut words = line.split_whitespace().map(str::to_string);
                (words.next().unwrap(), words.collect())
            })
            .collect()
    }
    fn lay(spec: &[&str], connect_missing: bool) -> Layout {
        let owned = rows(spec);
        let rows: Vec<Row> = owned.iter().map(|(h, p)| Row { hash: h, parents: p }).collect();
        layout(&rows, connect_missing)
    }
    /// [start, end, lane, from, to, colour] per span.
    fn spans(l: &Layout) -> Vec<[u32; SPAN]> {
        l.spans.chunks(SPAN).map(|s| [s[0], s[1], s[2], s[3], s[4], s[5]]).collect()
    }
    fn dangling(l: &Layout) -> Vec<[u32; DANGLING]> {
        l.dangling.chunks(DANGLING).map(|s| [s[0], s[1], s[2]]).collect()
    }

    #[test]
    fn a_straight_line_uses_one_lane_and_one_colour() {
        let l = lay(&["c b", "b a", "a"], false);
        assert_eq!(l.lanes, 1);
        assert_eq!(l.node_lane, [0, 0, 0]);
        assert_eq!(l.node_colour, [0, 0, 0]);
        assert_eq!(spans(&l), [[0, 1, 0, 0, 0, 0], [1, 2, 0, 0, 0, 0]]);
        assert_eq!(dangling(&l), Vec::<[u32; 3]>::new());
    }

    #[test]
    fn a_branch_and_its_merge() {
        // m merges f (lane 1) into d; the two lines meet at b.
        let l = lay(&["m d f", "f e", "d b", "e b", "b a", "a"], false);
        assert_eq!(l.node_lane, [0, 1, 0, 1, 0, 0]);
        assert_eq!(l.node_colour, [0, 1, 0, 1, 0, 0]);
        assert_eq!(l.lanes, 2);
        assert_eq!(
            spans(&l),
            [
                [0, 1, 1, 0, 1, 1], // m → f: out of m's node (lane 0) into lane 1
                [0, 2, 0, 0, 0, 0], // m → d
                [1, 3, 1, 1, 1, 1], // f → e
                [2, 4, 0, 0, 0, 0], // d → b
                [3, 4, 1, 1, 0, 1], // e → b: lane 1 ends in b's node (lane 0)
                [4, 5, 0, 0, 0, 0], // b → a
            ]
        );
    }

    #[test]
    fn a_second_parent_already_waited_for_joins_that_lane() {
        // Two merges of the same side branch: the second one's line joins lane 1, no third lane.
        let l = lay(&["m2 m1 s", "m1 a s", "s a", "a"], false);
        assert_eq!(l.lanes, 2);
        assert_eq!(l.node_lane, [0, 0, 1, 0]);
        assert_eq!(
            spans(&l),
            [
                [0, 1, 0, 0, 0, 0], // m2 → m1
                [0, 2, 1, 0, 1, 1], // m2 → s, a new lane
                [1, 2, 1, 0, 1, 1], // m1 → s: a line of its own into the waiting lane 1
                [1, 3, 0, 0, 0, 0], // m1 → a
                [2, 3, 1, 1, 0, 1], // s → a
            ]
        );
    }

    #[test]
    fn an_octopus_merge_opens_a_lane_per_extra_parent() {
        let l = lay(&["o a b c", "a r", "b r", "c r", "r"], false);
        assert_eq!(l.lanes, 3);
        assert_eq!(l.node_lane, [0, 0, 1, 2, 0]);
        assert_eq!(l.node_colour, [0, 0, 1, 2, 0]);
        assert_eq!(spans(&l)[..3], [[0, 1, 0, 0, 0, 0], [0, 2, 1, 0, 1, 1], [0, 3, 2, 0, 2, 2]]);
        assert_eq!(spans(&l)[3..], [[1, 4, 0, 0, 0, 0], [2, 4, 1, 1, 0, 1], [3, 4, 2, 2, 0, 2]]);
    }

    #[test]
    fn criss_cross_merges() {
        // y is waited for by nobody while lanes 0 and 1 are taken: it opens lane 2.
        let l = lay(&["x a b", "y b a", "a r", "b r", "r"], false);
        assert_eq!(l.node_lane, [0, 2, 0, 1, 0]);
        assert_eq!(l.lanes, 3);
        assert!(spans(&l).contains(&[1, 2, 0, 2, 0, 0]), "y → a joins lane 0: {:?}", spans(&l));
        assert!(spans(&l).contains(&[1, 3, 2, 2, 1, 2]), "y → b: lane 2 ends in b's node (lane 1)");
    }

    #[test]
    fn several_roots_and_freed_columns_are_reused() {
        // Two unrelated histories: the second starts after the first's root freed lane 0.
        let l = lay(&["b a", "a", "y x", "x"], false);
        assert_eq!(l.node_lane, [0, 0, 0, 0]);
        assert_eq!(l.node_colour, [0, 0, 1, 1]);
        assert_eq!(l.lanes, 1);
        // Interleaved: both alive at once.
        let l = lay(&["b a", "y x", "a", "x"], false);
        assert_eq!(l.node_lane, [0, 1, 0, 1]);
        assert_eq!(l.lanes, 2);
        assert_eq!(spans(&l), [[0, 2, 0, 0, 0, 0], [1, 3, 1, 1, 1, 1]]);
    }

    #[test]
    fn a_parent_that_is_not_loaded_fades_out_or_runs_on() {
        let l = lay(&["c b", "b a"], false);
        assert_eq!(spans(&l), [[0, 1, 0, 0, 0, 0]]);
        assert_eq!(dangling(&l), [[1, 0, 0]]);
        let l = lay(&["c b", "b a"], true);
        assert_eq!(spans(&l), [[0, 1, 0, 0, 0, 0], [1, 2, 0, 0, 0, 0]], "runs off the bottom (end == rows)");
        assert_eq!(dangling(&l), Vec::<[u32; 3]>::new());
        // A merge whose second parent is beyond the page, twice: one lane for it, joined.
        let l = lay(&["m1 b x", "m2 a x", "b a", "a"], true);
        assert_eq!(l.lanes, 3);
        assert_eq!(l.node_lane, [0, 2, 0, 0]);
        assert!(spans(&l).contains(&[0, 4, 1, 0, 1, 1]), "lane 1 waits for x to the bottom: {:?}", spans(&l));
        assert!(spans(&l).contains(&[1, 2, 1, 2, 1, 1]), "m2's line into lane 1");
        let l = lay(&["m1 b x", "m2 a x", "b a", "a"], false);
        assert_eq!(l.lanes, 2);
        assert_eq!(dangling(&l), [[0, 0, 0], [1, 1, 1]]);
    }

    #[test]
    fn the_uncommitted_row_and_a_stash_are_ordinary_rows() {
        // "*" on top of HEAD; a stash whose index and untracked commits are not rows.
        let l = lay(&["* h", "s h i u", "h g", "g"], false);
        assert_eq!(l.node_lane, [0, 1, 0, 0]);
        assert_eq!(l.lanes, 2);
        assert_eq!(dangling(&l), [[1, 1, 1]], "one fading line for both missing parents");
    }

    #[test]
    fn duplicate_parents_count_once() {
        let l = lay(&["m a a", "a"], false);
        assert_eq!(l.lanes, 1);
        assert_eq!(spans(&l), [[0, 1, 0, 0, 0, 0]]);
    }

    #[test]
    fn the_rows_above_do_not_change_when_more_are_loaded() {
        // A pseudo-random DAG: each commit has one or two parents among the next few rows.
        let mut seed = 12345u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        let n = 2000;
        let spec: Vec<String> = (0..n)
            .map(|i| {
                let mut line = format!("c{i}");
                let parents = 1 + (next() % 3 == 0) as usize;
                for _ in 0..parents {
                    let p = i + 1 + next() % 6;
                    if p < n {
                        line.push_str(&format!(" c{p}"));
                    }
                }
                line
            })
            .collect();
        let all: Vec<&str> = spec.iter().map(String::as_str).collect();
        let full = lay(&all, true);
        assert!(full.lanes > 2 && (full.lanes as usize) < MAX_LANES, "{} lanes", full.lanes);
        for &k in &[1, 7, 300, 1234, 1999] {
            let part = lay(&all[..k], true);
            assert_eq!(part.node_lane[..], full.node_lane[..k], "node lanes of the first {k}");
            assert_eq!(part.node_colour[..], full.node_colour[..k]);
            // Every span of the part is one of the full layout, cut at row k where it ran off.
            let whole = spans(&full);
            for s in spans(&part) {
                let same = whole.iter().any(|w| {
                    w[0] == s[0] && w[2] == s[2] && w[3] == s[3] && w[5] == s[5] && ((w[1] == s[1] && w[4] == s[4]) || (s[1] == k as u32 && s[4] == s[2] && w[1] >= k as u32))
                });
                assert!(same, "span {s:?} of the first {k} rows is not in the full layout");
            }
        }
    }

    #[test]
    fn the_lane_count_is_capped() {
        // Every row's parents are different unloaded commits: without the cap, two lanes a row.
        let spec: Vec<String> = (0..300).map(|i| format!("c{i} p{i} q{i}")).collect();
        let all: Vec<&str> = spec.iter().map(String::as_str).collect();
        let l = lay(&all, true);
        assert_eq!(l.lanes as usize, MAX_LANES);
        assert!(l.node_lane.iter().all(|&lane| (lane as usize) < MAX_LANES));
        assert!(!l.dangling.is_empty(), "what no lane is left for fades out");
        assert!(spans(&l).iter().all(|s| (s[2] as usize) < MAX_LANES && s[0] <= s[1]));
    }

    #[test]
    fn spans_come_sorted_by_their_first_row() {
        let l = lay(&["m d f", "f e", "d b", "e b", "b a", "a"], true);
        let starts: Vec<u32> = spans(&l).iter().map(|s| s[0]).collect();
        let mut sorted = starts.clone();
        sorted.sort_unstable();
        assert_eq!(starts, sorted);
    }
}
