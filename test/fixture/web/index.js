// The fixture app's page: exercises the shell protocol a browser-only app
// uses (read, write, the open dialog) and what smoke.mjs checks: the
// document's name as the title, a readiness text, and a file written when
// its "run" control is pressed.
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
})();
