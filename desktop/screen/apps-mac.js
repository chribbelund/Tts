// Which program is in front, on macOS, run by `osascript -l JavaScript`, so
// nothing has to be compiled and no permission is needed. screen-main.js puts
// a line before this one saying what to do: const MODE = 'watch' or 'list'.
//
//   watch  One line each time another program comes to the front:
//            {"app":{"pid":123,"exe":"Hades","name":"Hades","id":"com.…"}}
//   list   One line with the programs that have a window open, then it stops:
//            {"apps":[{…}, …]}

ObjC.import('AppKit');

const stdout = $.NSFileHandle.fileHandleWithStandardOutput;

function write(obj) {
  stdout.writeData($(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

function str(value) {
  try {
    const s = ObjC.unwrap(value);
    return typeof s === 'string' ? s : '';
  } catch (e) {
    return '';
  }
}

function describe(app) {
  let exe = '';
  try { exe = str(app.executableURL.lastPathComponent); } catch (e) { exe = ''; }
  return { pid: Number(app.processIdentifier), exe, name: str(app.localizedName), id: str(app.bundleIdentifier), title: '' };
}

const workspace = $.NSWorkspace.sharedWorkspace;

if (MODE === 'list') {
  const running = workspace.runningApplications;
  const apps = [];
  for (let i = 0; i < Number(running.count); i++) {
    const app = running.objectAtIndex(i);
    // 0 is an ordinary program with a window and a Dock icon.
    if (Number(app.activationPolicy) === 0) apps.push(describe(app));
  }
  write({ apps });
} else {
  write({ ready: true });
  let last = -1;
  for (;;) {
    // Running the loop lets macOS tell us the front program changed.
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.8));
    const app = workspace.frontmostApplication;
    if (!app || app.isNil()) continue;
    const pid = Number(app.processIdentifier);
    if (pid === last) continue;
    last = pid;
    write({ app: describe(app) });
  }
}
