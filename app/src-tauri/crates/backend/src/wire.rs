//! The protocol between the app and its remote helper (crates/remote), over the helper's
//! stdin and stdout through ssh.
//!
//! A frame is an ASCII header line `<id> <kind> <len>\n` followed by `len` bytes. `id` is the
//! request the frame belongs to (chosen by the app). Kinds:
//!
//! | from   | kind    | body                                                       |
//! |--------|---------|------------------------------------------------------------|
//! | app    | `Q`     | the request, JSON `{"op": ..}`                             |
//! | app    | `C`     | empty: cancel request `id` (an operation, a watch)         |
//! | helper | `P`     | a part of the result, at most [`CHUNK`] bytes              |
//! | helper | `R`     | the last part: all parts together are the result (JSON)    |
//! | helper | `E`     | the request failed: the message                            |
//! | helper | `V`     | an event of a request still open (a watch, an operation)   |
//!
//! Results travel in parts so that a large one (a file of the work tree) does not hold up the
//! answers to other requests.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL: u32 = 1;
/// The helper's first line, followed by a space and its hello (JSON); frames only from then on.
pub const READY: &str = "@@GG-READY@@";
/// The largest part of a result.
pub const CHUNK: usize = 64 * 1024;
/// No frame is larger (requests are small, results come in parts): anything else is not ours.
const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub id: u64,
    pub kind: u8,
    pub body: Vec<u8>,
}

impl Frame {
    pub fn new(id: u64, kind: u8, body: impl Into<Vec<u8>>) -> Frame {
        Frame { id, kind, body: body.into() }
    }
}

pub async fn write_frame<W: AsyncWrite + Unpin>(to: &mut W, frame: &Frame) -> io::Result<()> {
    to.write_all(format!("{} {} {}\n", frame.id, frame.kind as char, frame.body.len()).as_bytes()).await?;
    to.write_all(&frame.body).await?;
    to.flush().await
}

/// The next frame; `None` at the end of the stream.
pub async fn read_frame<R: AsyncBufRead + Unpin>(from: &mut R) -> io::Result<Option<Frame>> {
    let mut header = String::new();
    if from.read_line(&mut header).await? == 0 {
        return Ok(None);
    }
    let bad = || io::Error::new(io::ErrorKind::InvalidData, format!("not a frame header: {:?}", header.trim_end()));
    let mut parts = header.trim_end_matches('\n').split(' ');
    let (Some(id), Some(kind), Some(len), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return Err(bad()) };
    let (Ok(id), [kind], Ok(len)) = (id.parse::<u64>(), kind.as_bytes(), len.parse::<usize>()) else { return Err(bad()) };
    if len > MAX_FRAME {
        return Err(bad());
    }
    let mut body = vec![0; len];
    from.read_exact(&mut body).await?;
    Ok(Some(Frame { id, kind: *kind, body }))
}

/// `result` as the frames that answer request `id`.
pub fn answer(id: u64, result: Result<Vec<u8>, String>) -> Vec<Frame> {
    match result {
        Err(message) => vec![Frame::new(id, b'E', message)],
        Ok(bytes) => {
            let mut frames: Vec<Frame> = bytes.chunks(CHUNK).map(|part| Frame::new(id, b'P', part)).collect();
            match frames.last_mut() {
                Some(last) => last.kind = b'R',
                None => frames.push(Frame::new(id, b'R', Vec::new())),
            }
            frames
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_survive_a_pipe_that_delivers_them_in_pieces() {
        let frames = vec![
            Frame::new(1, b'Q', "{\"op\":\"scan\"}"),
            Frame::new(2, b'C', ""),
            Frame::new(u64::MAX, b'P', vec![0u8, 10, 255, b' ', b'\n']),
            Frame::new(3, b'R', "é".repeat(5000)),
        ];
        let (mut tx, rx) = tokio::io::duplex(7); // far smaller than a frame
        let sent = frames.clone();
        let writer = tokio::spawn(async move {
            for frame in &sent {
                write_frame(&mut tx, frame).await.unwrap();
            }
        });
        let mut rx = tokio::io::BufReader::new(rx);
        let mut got = Vec::new();
        while let Some(frame) = read_frame(&mut rx).await.unwrap() {
            got.push(frame);
        }
        writer.await.unwrap();
        assert_eq!(got, frames);
    }

    #[tokio::test]
    async fn what_is_not_a_frame_is_an_error() {
        for junk in ["hello\n", "1 Q\n", "1 QQ 0\n", "x Q 0\n", "1 Q -1\n", "1 Q 0 0\n", "1 Q 99999999999\n"] {
            let mut input = tokio::io::BufReader::new(junk.as_bytes());
            assert!(read_frame(&mut input).await.is_err(), "{junk:?}");
        }
        let mut cut = tokio::io::BufReader::new("1 Q 10\nshort".as_bytes());
        assert!(read_frame(&mut cut).await.is_err(), "a body cut short");
    }

    #[test]
    fn a_result_is_answered_in_parts_ending_with_r() {
        let kinds = |frames: Vec<Frame>| frames.iter().map(|f| (f.kind as char, f.body.len())).collect::<Vec<_>>();
        assert_eq!(kinds(answer(1, Ok(Vec::new()))), [('R', 0)]);
        assert_eq!(kinds(answer(1, Ok(vec![1; CHUNK]))), [('R', CHUNK)]);
        assert_eq!(kinds(answer(1, Ok(vec![1; 2 * CHUNK + 5]))), [('P', CHUNK), ('P', CHUNK), ('R', 5)]);
        assert_eq!(kinds(answer(1, Err("no".into()))), [('E', 2)]);
    }
}
