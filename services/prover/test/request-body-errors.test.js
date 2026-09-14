// A body the service cannot read is refused in JSON, logged as one JSON line, and
// carries nothing of the request.
//
// square#252. express.json's errors went to Express's default handler: an HTML
// page for the caller, and in production the stack written to stderr as bare
// lines. The OpenAPI spec promised JSON on the error path, the log pipeline reads
// one JSON object per line, and body-parser's SyntaxError quotes the start of the
// raw body, so the stack put request bytes in the log.
//
// Express's default handler writes the stack only when the app's env is not
// `test`, so under vitest it would stay silent even without the fix. The app is
// switched to `production` here, which is what the Dockerfile runs, so these
// tests would see that stack if it came back.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

describe('a request body the service cannot read', () => {
  let app;
  let request;
  let captured = [];
  let env;
  const original = { log: console.log, error: console.error };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    ({ app } = await import('../src/index.js'));
    ({ default: request } = await import('supertest'));
    env = app.get('env');
    app.set('env', 'production');
  });

  afterAll(() => {
    app.set('env', env);
  });

  afterEach(() => {
    console.log = original.log;
    console.error = original.error;
  });

  const send = async (body) => {
    captured = [];
    console.log = (...args) => { captured.push(args.join(' ')); };
    console.error = (...args) => { captured.push(args.join(' ')); };
    const response = await request(app).post('/prove').set('Content-Type', 'application/json').send(body);
    console.log = original.log;
    console.error = original.error;
    return response;
  };

  // One log line, and it is a JSON object: what a JSON-lines pipeline can read.
  const theLogLine = () => {
    const lines = captured.join('\n').split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
  };

  const LEAKS = ['SyntaxError', 'PayloadTooLargeError', 'body-parser', 'raw-body', 'node_modules', '    at ', '<pre>'];

  it('answers malformed JSON with a JSON 400 and one request_rejected line', async () => {
    const response = await send('{"policy_id":"abc", }');
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ error: 'the request body is not valid JSON' });
    expect(theLogLine()).toEqual({ event: 'request_rejected', error: 'the request body is not valid JSON' });
  });

  it('keeps the raw body and the stack out of the response and the log', async () => {
    const secret = '987654321987';
    const response = await send(`max_daily_spend=${secret}`);
    expect(response.status).toBe(400);
    const everything = `${response.text}\n${captured.join('\n')}`;
    for (const leak of [...LEAKS, 'max_daily_', secret]) {
      expect(everything, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it('answers a 300 KB body with a JSON 413 and one request_rejected line', async () => {
    const response = await send(JSON.stringify({ padding: 'x'.repeat(300 * 1024) }));
    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ error: 'the request body is larger than the 256kb this service accepts' });
    expect(theLogLine()).toEqual({
      event: 'request_rejected',
      error: 'the request body is larger than the 256kb this service accepts',
    });
    const everything = `${response.text}\n${captured.join('\n')}`;
    for (const leak of LEAKS) {
      expect(everything, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it('declares 413 in the OpenAPI spec, with the JSON error body', async () => {
    const spec = (await request(app).get('/api-docs.json')).body;
    expect(spec.paths['/prove'].post.responses['413'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/Error');
  });
});
