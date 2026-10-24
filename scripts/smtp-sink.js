#!/usr/bin/env node
// A tiny SMTP server that keeps what it receives, for tests and CI: no mail leaves the machine.
//   node scripts/smtp-sink.js [port] [file]   listens on 127.0.0.1:port (default 2525) and appends every
//                                             message as one JSON line to file (default ./smtp-sink.jsonl)
// As a module: startSink({ port, tls, auth }) -> { port, messages, close() }
//   tls   { key, cert }  serve TLS from the first byte (like port 465)
//   auth  { user, pass } require AUTH PLAIN or LOGIN with these credentials
'use strict';
const net = require('net');
const tlsLib = require('tls');
const fs = require('fs');

function startSink({ port = 0, tls = null, auth = null, onMessage = null } = {}) {
  const messages = [];
  const handle = (socket) => {
    let buf = '', inData = false, data = '', state = 'cmd', authed = !auth, mailFrom = null, rcpts = [], loginUser = null;
    const send = (line) => socket.write(line + '\r\n');
    send('220 sink ESMTP ready');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf += chunk.toString('binary');
      let i;
      while (inData ? (i = buf.indexOf('\r\n.\r\n')) !== -1 : (i = buf.indexOf('\r\n')) !== -1) {
        if (inData) {
          data += buf.slice(0, i + 2); buf = buf.slice(i + 5); inData = false;
          const raw = data.replace(/^\./gm, '');
          const msg = { from: mailFrom, to: rcpts, raw: Buffer.from(raw, 'binary').toString('utf8') };
          messages.push(msg); if (onMessage) onMessage(msg);
          data = ''; mailFrom = null; rcpts = []; send('250 OK queued'); continue;
        }
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (state === 'plain') { state = 'cmd'; const [, u, p] = Buffer.from(line, 'base64').toString().split('\0'); authed = (!auth || (u === auth.user && p === auth.pass)); send(authed ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication failed'); continue; }
        if (state === 'login-user') { loginUser = Buffer.from(line, 'base64').toString(); state = 'login-pass'; send('334 UGFzc3dvcmQ6'); continue; }
        if (state === 'login-pass') { state = 'cmd'; authed = (!auth || (loginUser === auth.user && Buffer.from(line, 'base64').toString() === auth.pass)); send(authed ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication failed'); continue; }
        const [cmd, ...rest] = line.split(' '); const arg = rest.join(' ');
        switch (cmd.toUpperCase()) {
          case 'EHLO': case 'HELO': socket.write('250-sink\r\n' + (auth ? '250-AUTH PLAIN LOGIN\r\n' : '') + '250 8BITMIME\r\n'); break;
          case 'AUTH':
            if (/^PLAIN/i.test(arg)) { const ir = arg.split(' ')[1]; if (ir) { const [, u, p] = Buffer.from(ir, 'base64').toString().split('\0'); authed = (!auth || (u === auth.user && p === auth.pass)); send(authed ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication failed'); } else { state = 'plain'; send('334 '); } }
            else if (/^LOGIN/i.test(arg)) { state = 'login-user'; send('334 VXNlcm5hbWU6'); }
            else send('504 unsupported');
            break;
          case 'MAIL': if (!authed) { send('530 5.7.0 Authentication required'); break; } mailFrom = (arg.match(/<([^>]*)>/) || [])[1] || arg; send('250 OK'); break;
          case 'RCPT': if (!authed) { send('530 5.7.0 Authentication required'); break; } rcpts.push((arg.match(/<([^>]*)>/) || [])[1] || arg); send('250 OK'); break;
          case 'DATA': inData = true; send('354 End data with <CR><LF>.<CR><LF>'); break;
          case 'RSET': mailFrom = null; rcpts = []; send('250 OK'); break;
          case 'NOOP': send('250 OK'); break;
          case 'QUIT': send('221 Bye'); socket.end(); break;
          default: send('502 not implemented');
        }
      }
    });
  };
  const server = tls ? tlsLib.createServer({ key: tls.key, cert: tls.cert }, handle) : net.createServer(handle);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    port: server.address().port, messages, close: () => new Promise((r) => server.close(r)),
  })));
}

module.exports = { startSink };

if (require.main === module) {
  const port = Number(process.argv[2]) || 2525;
  const file = process.argv[3] || './smtp-sink.jsonl';
  startSink({ port, onMessage: (m) => fs.appendFileSync(file, JSON.stringify(m) + '\n') })
    .then((s) => console.log(`SMTP sink listening on 127.0.0.1:${s.port}, writing to ${file}`));
}
