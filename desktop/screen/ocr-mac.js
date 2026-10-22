// Text recognition on macOS with Apple's Vision framework, run by
// `osascript -l JavaScript` (JavaScript for Automation), so nothing has to be
// compiled. screen-main.js starts it once and keeps it running: the first
// recognition loads Vision's model, every one after that is fast.
//
// One job per line on stdin:  {"id":1,"png":"<base64>","fast":false,"langs":["en-US"]}
// One answer per line out:    {"id":1,"lines":[{"text":"…","conf":0.9,"box":[x,y,w,h]}]}
// Boxes are fractions of the image, measured from the top left.

ObjC.import('Foundation');
ObjC.import('Vision');

const stdin = $.NSFileHandle.fileHandleWithStandardInput;
const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
let pending = '';

function write(obj) {
  stdout.writeData($(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

function readLine() {
  for (;;) {
    const at = pending.indexOf('\n');
    if (at >= 0) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      return line;
    }
    const data = stdin.availableData;
    if (Number(data.length) === 0) return null;
    pending += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  }
}

function recognize(job) {
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions(job.png, 0);
  if (!data || data.isNil()) throw new Error('the picture could not be read');
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = job.fast ? 1 : 0;   // 1 = fast, 0 = accurate
  request.usesLanguageCorrection = !job.fast;
  if (Array.isArray(job.langs) && job.langs.length) {
    try { request.recognitionLanguages = $(job.langs); } catch (e) { /* older macOS */ }
  } else {
    try { request.automaticallyDetectsLanguage = true; } catch (e) { /* before macOS 13 */ }
  }
  const handler = $.VNImageRequestHandler.alloc.initWithDataOptions(data, $({}));
  const error = $();
  if (!handler.performRequestsError($([request]), error)) {
    throw new Error(error.localizedDescription ? error.localizedDescription.js : 'Vision could not read the picture');
  }
  const lines = [];
  const results = request.results;
  const count = results ? Number(results.count) : 0;
  for (let i = 0; i < count; i++) {
    const observation = results.objectAtIndex(i);
    const candidates = observation.topCandidates(1);
    if (!Number(candidates.count)) continue;
    const best = candidates.objectAtIndex(0);
    const b = observation.boundingBox;   // origin at the bottom left
    lines.push({
      text: best.string.js,
      conf: best.confidence,
      box: [b.origin.x, 1 - b.origin.y - b.size.height, b.size.width, b.size.height],
    });
  }
  return lines;
}

function main() {
  write({ ready: true, engine: 'Apple Vision' });
  for (;;) {
    const line = readLine();
    if (line === null) return;
    if (!line.trim()) continue;
    let job = null;
    try {
      job = JSON.parse(line);
      const started = Date.now();
      const lines = recognize(job);
      write({ id: job.id, lines, ms: Date.now() - started });
    } catch (e) {
      write({ id: job ? job.id : null, error: String((e && e.message) || e) });
    }
  }
}

main();
''
