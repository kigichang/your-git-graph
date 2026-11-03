# usage: python3 -I basic_auth_server.py <portfile> <logfile>
# 401 + WWW-Authenticate without credentials; with credentials, log them (decoded) and answer 403.
import base64, http.server, sys
portfile, logfile = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get('Authorization')
        if not auth:
            self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="gg"'); self.end_headers(); return
        with open(logfile, 'a') as f:
            f.write('auth: ' + base64.b64decode(auth.split(' ', 1)[1]).decode() + '\n')
        self.send_response(403); self.end_headers()
    def log_message(self, *a): pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
open(portfile, 'w').write(str(srv.server_address[1]))
srv.serve_forever()
