var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../.wrangler/tmp/bundle-igzrnu/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init2) {
  const request = new Request(input, init2);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// api/[[path]].js
var MAX_BODY = 1e6;
var MAX_ITEMS = 5e3;
var KEEP_SNAPSHOTS = 30;
var TZ = "Europe/London";
var ready = false;
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
__name(json, "json");
async function init(db) {
  if (ready)
    return;
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT, label TEXT NOT NULL, data TEXT NOT NULL)"
    )
  ]);
  ready = true;
}
__name(init, "init");
function count(v, max = 99999) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    return 0;
  return Math.min(Math.floor(n), max);
}
__name(count, "count");
function clean(s) {
  if (!s || !Array.isArray(s.items) || s.items.length > MAX_ITEMS)
    return null;
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const r of s.items) {
    if (!r || typeof r.name !== "string" || typeof r.group !== "string")
      return null;
    const id = Math.floor(Number(r.id));
    if (!Number.isFinite(id) || id < 1 || seen.has(id))
      return null;
    seen.add(id);
    const name = r.name.trim().slice(0, 200);
    const group = r.group.trim().slice(0, 100);
    if (!name || !group)
      return null;
    items.push({
      id,
      name,
      group,
      low: count(r.low),
      paused: !!r.paused,
      m: count(r.m),
      b: count(r.b)
    });
  }
  const counted = { m: {}, b: {} };
  for (const l of ["m", "b"]) {
    const src = s.counted && s.counted[l];
    if (src && typeof src === "object") {
      for (const k of Object.keys(src))
        if (seen.has(Number(k)) && src[k])
          counted[l][k] = true;
    }
  }
  const maxId = items.reduce((a, i) => Math.max(a, i.id), 0);
  return { items, counted, nextId: Math.max(count(s.nextId), maxId + 1) };
}
__name(clean, "clean");
function londonDay(now = /* @__PURE__ */ new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
}
__name(londonDay, "londonDay");
function londonLabel(now = /* @__PURE__ */ new Date()) {
  return "Start of " + now.toLocaleDateString("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
}
__name(londonLabel, "londonLabel");
async function pruneSnapshots(db) {
  await db.prepare("DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY ts DESC LIMIT ?)").bind(KEEP_SNAPSHOTS).run();
}
__name(pruneSnapshots, "pruneSnapshots");
async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY)
    return { error: "Too large" };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: "Invalid JSON" };
  }
}
__name(readBody, "readBody");
async function getState(db) {
  const cur = await db.prepare("SELECT version, data FROM app_state WHERE id = 1").first();
  if (!cur)
    return json({ version: 0, state: null });
  return json({ version: cur.version, state: JSON.parse(cur.data) });
}
__name(getState, "getState");
async function putState(db, request) {
  const { body, error } = await readBody(request);
  if (error)
    return json({ error }, 400);
  const state = clean(body && body.state);
  if (!state)
    return json({ error: "Invalid state" }, 400);
  const baseVersion = Number(body.baseVersion) || 0;
  const force = body.force === true;
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
  const cur = await db.prepare("SELECT version, data FROM app_state WHERE id = 1").first();
  const curVersion = cur ? cur.version : 0;
  if (!force && baseVersion !== curVersion) {
    return json({ version: curVersion, state: cur ? JSON.parse(cur.data) : null }, 409);
  }
  const now = Date.now();
  if (cur) {
    if (force && label) {
      await db.prepare("INSERT INTO snapshots (id, ts, day, label, data) VALUES (?, ?, NULL, ?, ?)").bind("x-" + now, now, label, cur.data).run();
    } else {
      const day = londonDay();
      const has = await db.prepare("SELECT 1 AS x FROM snapshots WHERE day = ?").bind(day).first();
      if (!has) {
        await db.prepare("INSERT INTO snapshots (id, ts, day, label, data) VALUES (?, ?, ?, ?, ?)").bind("d-" + day, now, day, londonLabel(), cur.data).run();
      }
    }
  }
  const data = JSON.stringify(state);
  const next = curVersion + 1;
  if (cur) {
    const res = await db.prepare("UPDATE app_state SET version = ?, data = ?, updated_at = ? WHERE id = 1 AND version = ?").bind(next, data, now, curVersion).run();
    if (!res.meta || res.meta.changes !== 1) {
      const again = await db.prepare("SELECT version, data FROM app_state WHERE id = 1").first();
      return json({ version: again.version, state: JSON.parse(again.data) }, 409);
    }
  } else {
    try {
      await db.prepare("INSERT INTO app_state (id, version, data, updated_at) VALUES (1, ?, ?, ?)").bind(next, data, now).run();
    } catch {
      const again = await db.prepare("SELECT version, data FROM app_state WHERE id = 1").first();
      if (again)
        return json({ version: again.version, state: JSON.parse(again.data) }, 409);
      throw new Error("insert failed");
    }
  }
  await pruneSnapshots(db);
  return json({ version: next });
}
__name(putState, "putState");
async function listSnapshots(db) {
  const { results } = await db.prepare("SELECT id, ts, label, data FROM snapshots ORDER BY ts DESC LIMIT ?").bind(KEEP_SNAPSHOTS).all();
  const snapshots = results.map((r) => {
    let items = 0;
    let units = 0;
    try {
      const s = JSON.parse(r.data);
      items = s.items.length;
      units = s.items.reduce((a, i) => a + i.m + i.b, 0);
    } catch {
    }
    return { id: r.id, ts: r.ts, label: r.label, items, units };
  });
  return json({ snapshots });
}
__name(listSnapshots, "listSnapshots");
async function restore(db, request) {
  const { body, error } = await readBody(request);
  if (error)
    return json({ error }, 400);
  const id = body && typeof body.id === "string" ? body.id : "";
  const snap = await db.prepare("SELECT data FROM snapshots WHERE id = ?").bind(id).first();
  if (!snap)
    return json({ error: "Copy not found" }, 404);
  const cur = await db.prepare("SELECT version, data FROM app_state WHERE id = 1").first();
  const now = Date.now();
  if (cur) {
    await db.prepare("INSERT INTO snapshots (id, ts, day, label, data) VALUES (?, ?, NULL, ?, ?)").bind("r-" + now, now, "Before restore, " + new Date(now).toLocaleString("en-GB", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), cur.data).run();
    await db.prepare("UPDATE app_state SET version = ?, data = ?, updated_at = ? WHERE id = 1").bind(cur.version + 1, snap.data, now).run();
  } else {
    await db.prepare("INSERT INTO app_state (id, version, data, updated_at) VALUES (1, 1, ?, ?)").bind(snap.data, now).run();
  }
  await pruneSnapshots(db);
  const fresh = await db.prepare("SELECT version, data FROM app_state WHERE id = 1").first();
  return json({ version: fresh.version, state: JSON.parse(fresh.data) });
}
__name(restore, "restore");
async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) {
    return json({ error: "Database not connected. Bind a D1 database named DB to this project." }, 500);
  }
  const route = Array.isArray(params.path) ? params.path.join("/") : String(params.path || "");
  const method = request.method;
  try {
    await init(db);
    if (route === "state" && method === "GET")
      return await getState(db);
    if (route === "state" && method === "PUT")
      return await putState(db, request);
    if (route === "snapshots" && method === "GET")
      return await listSnapshots(db);
    if (route === "restore" && method === "POST")
      return await restore(db, request);
    if (["state", "snapshots", "restore"].includes(route))
      return json({ error: "Method not allowed" }, 405);
    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: "Server error" }, 500);
  }
}
__name(onRequest, "onRequest");

// ../.wrangler/tmp/pages-5WeHpC/functionsRoutes-0.79006177638305.mjs
var routes = [
  {
    routePath: "/api/:path*",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];

// ../../../../tmp/claude-0/-home-claude/be34a94a-d8b8-5602-a00b-df180cd4a596/scratchpad/wr/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count2 = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count2--;
          if (count2 === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count2++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count2)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../tmp/claude-0/-home-claude/be34a94a-d8b8-5602-a00b-df180cd4a596/scratchpad/wr/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init2) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init2);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: () => {
            isFailOpen = true;
          }
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");

// ../../../../tmp/claude-0/-home-claude/be34a94a-d8b8-5602-a00b-df180cd4a596/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../tmp/claude-0/-home-claude/be34a94a-d8b8-5602-a00b-df180cd4a596/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// ../.wrangler/tmp/bundle-igzrnu/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;

// ../../../../tmp/claude-0/-home-claude/be34a94a-d8b8-5602-a00b-df180cd4a596/scratchpad/wr/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// ../.wrangler/tmp/bundle-igzrnu/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init2) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init2.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init2) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init2.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=functionsWorker-0.9458976131409451.mjs.map
