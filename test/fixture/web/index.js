// The fixture app's page: exercises the shell protocol a browser-only app
// uses (read, write, the open dialog) and what smoke.mjs checks: the
// document's name as the title, a readiness text, a file written when
// its "run" control is pressed, and a History tile that opens the shell's
// History page over its room.
(function () {
  var shell = window.claerbout;
  var status = document.getElementById('status');
  var text = document.getElementById('text');
  var path = new URLSearchParams(window.location.search).get('open');

  function say(state) {
    status.textContent = state;
  }

  if (!shell) {
    say('no shell');
    return;
  }

  function show(reply) {
    if (!reply || reply.error) {
      say('error: ' + (reply && reply.error));
      return;
    }
    path = reply.path;
    document.title = reply.name;
    text.textContent = reply.text;
    say('ready');
  }

  if (path) shell.request({ type: 'read', path: path }).then(show);
  else say('ready');

  document.getElementById('save').addEventListener('click', function () {
    if (!path) return;
    shell.request({ type: 'write', path: path + '.copy', text: text.textContent }).then(function (reply) {
      say(reply && !reply.error ? 'saved' : 'error: ' + (reply && reply.error));
    });
  });
  document.getElementById('open').addEventListener('click', function () {
    shell.request({ type: 'open' }).then(function (reply) {
      if (reply && reply.path) shell.request({ type: 'read', path: reply.path }).then(show);
    });
  });

  // The History tile: the shell lays its History page over the room's box
  // (CSS px) in this window, moves it when the room's box changes, and
  // says when it opens or goes, so the tile reads pressed exactly then.
  // View › History… asks the page to do what the tile does (`toggle`).
  var tile = document.getElementById('history');
  var room = document.getElementById('room');
  var shown = false;
  function box() {
    var r = room.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  function toggleHistory() {
    if (shown) shell.request({ type: 'history', action: 'close' });
    else shell.request({ type: 'history', action: 'open', inline: box() });
  }
  tile.addEventListener('click', toggleHistory);
  shell.on('history', function (detail) {
    if (!detail) return;
    if (detail.kind === 'inline') {
      shown = detail.state === 'open';
      tile.classList.toggle('on', shown);
      tile.setAttribute('aria-pressed', String(shown));
    } else if (detail.kind === 'toggle') toggleHistory();
  });
  var frame = 0;
  new ResizeObserver(function () {
    if (!shown) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(function () {
      shell.request({ type: 'history', action: 'bounds', inline: box() });
    });
  }).observe(room);
})();
