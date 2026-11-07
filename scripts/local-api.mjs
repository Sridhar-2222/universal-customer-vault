// LOCAL TESTING ONLY: a tiny stand-in for Supabase's REST + auth endpoints on top of a throwaway local Postgres
// (stubs + migrations, as in scripts/test-db.sh). Every query runs as the signed-in test user with role
// `authenticated` and RLS on, like the real API, so the screens can be clicked through without a cloud project.
// It implements only what the app uses and accepts unsigned test tokens. Never point it at a real database.
// Usage: PGURL=postgres://postgres@localhost:54329/ucv_ui node scripts/local-api.mjs   (listens on 127.0.0.1:54321)
import http from "node:http";
import pg from "pg";

const PGURL = process.env.PGURL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(PGURL)) { console.error("Refusing: PGURL must be a local database"); process.exit(2); }
// Same JSON shapes as PostgREST: dates as "YYYY-MM-DD", bigint and numeric as numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
const pool = new pg.Pool({ connectionString: PGURL });
// supabase-js names the schema in Accept-Profile (reads) / Content-Profile (calls), like PostgREST.
const SCHEMAS = ["customer_vault", "public"];
const schemaOf = (req) => { const s = req.headers["accept-profile"] ?? req.headers["content-profile"] ?? "public"; return SCHEMAS.includes(s) ? s : null; };
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

const fkCache = new Map();
async function relation(db, S, from, to) {
  const key = `${S}.${from}>${to}`;
  if (fkCache.has(key)) return fkCache.get(key);
  const sql = `select c.conrelid = $1::regclass as from_is_child,
      array(select a.attname::text from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.o) as child_cols,
      array(select a.attname::text from unnest(c.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.o) as parent_cols
    from pg_constraint c where c.contype = 'f' and ((c.conrelid = $1::regclass and c.confrelid = $2::regclass) or (c.conrelid = $2::regclass and c.confrelid = $1::regclass))
    order by array_length(c.conkey, 1) desc`;
  const { rows } = await db.query(sql, [`${S}.${from}`, `${S}.${to}`]);
  const r = rows[0];
  const out = !r ? null : r.from_is_child
    ? { many: false, mine: r.child_cols, theirs: r.parent_cols }
    : { many: true, mine: r.parent_cols, theirs: r.child_cols };
  fkCache.set(key, out);
  return out;
}

function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
async function shape(db, S, table, rows, sel) {
  const parts = splitTop(sel || "*");
  for (const row of rows) {
    const out = {};
    for (const p of parts) {
      const m = p.match(/^([a-z_]+)\((.*)\)$/s);
      if (!m) { if (p === "*") Object.assign(out, row); else out[p] = row[p]; continue; }
      const [, rel, inner] = m;
      const fk = await relation(db, S, table, rel);
      if (!fk) throw Object.assign(new Error(`no relation ${table}->${rel}`), { code: "PGRST200" });
      const vals = fk.mine.map((c) => row[c]);
      const where = fk.theirs.map((c, i) => `${q(c)} = $${i + 1}`).join(" and ");
      const got = vals.some((v) => v == null) ? [] : (await db.query(`select * from ${S}.${q(rel)} where ${where}`, vals)).rows;
      const shaped = await shape(db, S, rel, got, inner);
      out[rel] = fk.many ? shaped : shaped[0] ?? null;
    }
    for (const k of Object.keys(row)) delete row[k];
    Object.assign(row, out);
  }
  return rows;
}
const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
async function select(db, S, table, params, wantCount) {
  const vals = [], conds = [];
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    const m = v.match(/^(eq|neq|gt|gte|lt|lte|in|is)\.(.*)$/s);
    if (!m) continue;
    if (m[1] === "is") conds.push(`${q(k)} is ${m[2] === "null" ? "null" : m[2] === "true" ? "true" : "false"}`);
    else if (m[1] === "in") { vals.push(m[2].replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""))); conds.push(`${q(k)} = any($${vals.length})`); }
    else { vals.push(m[2]); conds.push(`${q(k)} ${OPS[m[1]]} $${vals.length}`); }
  }
  const where = conds.length ? ` where ${conds.join(" and ")}` : "";
  const ord = params.get("order");
  const order = ord ? ` order by ${ord.split(",").map((o) => { const [c, dir, nulls] = o.split("."); return `${q(c)} ${dir === "desc" ? "desc" : "asc"}${nulls === "nullslast" ? " nulls last" : nulls === "nullsfirst" ? " nulls first" : ""}`; }).join(", ")}` : "";
  const limit = params.get("limit") ? ` limit ${Number(params.get("limit"))}` : "";
  const offset = params.get("offset") ? ` offset ${Number(params.get("offset"))}` : "";
  const count = wantCount ? Number((await db.query(`select count(*) from ${S}.${q(table)}${where}`, vals)).rows[0].count) : null;
  const rows = (await db.query(`select * from ${S}.${q(table)}${where}${order}${limit}${offset}`, vals)).rows;
  return { rows: await shape(db, S, table, rows, params.get("select")), count };
}
async function rpc(db, S, fn, args) {
  const { rows: fns } = await db.query(`select p.proretset, p.proargnames, t.typname, t.typtype from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join pg_type t on t.oid = p.prorettype where n.nspname = $2 and p.proname = $1`, [fn, S]);
  const keys = Object.keys(args);
  const f = fns.find((x) => keys.every((k) => (x.proargnames ?? []).includes(k)));
  if (!f) throw Object.assign(new Error(`Could not find the function ${S}.${fn}`), { code: "PGRST202" });
  const vals = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
  const call = `${S}.${q(fn)}(${keys.map((k, i) => `${q(k)} => $${i + 1}`).join(", ")})`;
  if (f.proretset || f.typtype === "c") return (await db.query(`select * from ${call}`, vals)).rows;
  const r = (await db.query(`select ${call} as v`, vals)).rows[0].v;
  return f.typname === "void" ? null : r;
}

const userOf = (req) => {
  const tok = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  try { const p = JSON.parse(Buffer.from(tok.split(".")[1] ?? "", "base64url").toString()); return p.sub && p.role === "authenticated" ? p : null; } catch { return null; }
};
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,HEAD,DELETE,OPTIONS", "access-control-expose-headers": "content-range" };
const send = (res, status, body, extra = {}) => { res.writeHead(status, { "content-type": "application/json", ...cors, ...extra }); res.end(body === undefined ? "" : JSON.stringify(body)); };

// Runs fn inside one transaction as the signed-in user (role + auth.uid()), with RLS on, like the real API.
async function asUser(user, fn) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(`set local role ${user ? "authenticated" : "anon"}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user?.sub ?? ""]);
    const out = await fn(db);
    await db.query("commit");
    return out;
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
}

// Storage: file bytes kept in memory; who may upload, read or delete is decided by the storage.objects policies.
const files = new Map(); // "bucket/name" -> { mime, bytes }
const tokens = new Map(); // signing token -> { key, until }
const storageErr = (res, status, error, message) => send(res, status, { statusCode: String(status), error, message });
async function storage(req, res, url, user) {
  const read = async () => { const parts = []; for await (const c of req) parts.push(c); return Buffer.concat(parts); };
  let m = url.pathname.match(/^\/storage\/v1\/object\/sign\/([a-z0-9_-]+)\/(.+)$/);
  if (m && req.method === "GET") { // open a signed link (no sign-in needed, like the real service)
    const t = tokens.get(url.searchParams.get("token") ?? "");
    const key = `${m[1]}/${decodeURIComponent(m[2])}`;
    if (!t || t.key !== key || t.until < Date.now() || !files.has(key)) return storageErr(res, 400, "InvalidSignature", "invalid or expired link");
    const f = files.get(key);
    res.writeHead(200, { "content-type": f.mime, ...cors }); return res.end(f.bytes);
  }
  if (m && req.method === "POST") { // create a signed link: only if this user may read the object
    const [bucket, name] = [m[1], decodeURIComponent(m[2])];
    const { expiresIn } = JSON.parse((await read()).toString() || "{}");
    const seen = await asUser(user, async (db) => (await db.query("select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, name])).rowCount);
    if (!seen) return storageErr(res, 400, "not_found", "Object not found");
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    tokens.set(token, { key: `${bucket}/${name}`, until: Date.now() + Number(expiresIn ?? 60) * 1000 });
    // The plain path, as the real service returns it; supabase-js applies encodeURI itself.
    return send(res, 200, { signedURL: `/object/sign/${bucket}/${name}?token=${token}` });
  }
  m = url.pathname.match(/^\/storage\/v1\/object\/([a-z0-9_-]+)\/(.+)$/);
  if (m && (req.method === "POST" || req.method === "PUT")) { // upload
    const [bucket, name] = [m[1], decodeURIComponent(m[2])];
    const bytes = await read(), mime = req.headers["content-type"] ?? "application/octet-stream";
    if (/^multipart\//.test(mime)) return storageErr(res, 415, "unsupported", "local-api accepts raw bytes only (the app uploads an ArrayBuffer)");
    if (!user) return storageErr(res, 403, "Unauthorized", "sign in");
    try {
      await asUser(user, (db) => db.query("insert into storage.objects(bucket_id, name, owner, metadata) values ($1, $2, $3, $4)",
        [bucket, name, user.sub, JSON.stringify({ mimetype: mime, size: bytes.length })]));
    } catch (e) { return storageErr(res, 403, "Unauthorized", `new row violates row-level security policy: ${e.message}`); }
    files.set(`${bucket}/${name}`, { mime, bytes });
    return send(res, 200, { Id: name, Key: `${bucket}/${name}` });
  }
  m = url.pathname.match(/^\/storage\/v1\/object\/([a-z0-9_-]+)$/);
  if (m && req.method === "DELETE") { // remove: only what the delete policy allows
    const { prefixes } = JSON.parse((await read()).toString() || "{}");
    const gone = await asUser(user, async (db) => (await db.query("delete from storage.objects where bucket_id = $1 and name = any($2) returning name", [m[1], prefixes ?? []])).rows);
    for (const g of gone) files.delete(`${m[1]}/${g.name}`);
    return send(res, 200, gone.map((g) => ({ name: g.name })));
  }
  return send(res, 404, { message: "not implemented in local-api" });
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204);
  const url = new URL(req.url, "http://x");
  const user = userOf(req);
  if (url.pathname === "/auth/v1/user") return user ? send(res, 200, { id: user.sub, email: user.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} }) : send(res, 401, { message: "no user" });
  if (url.pathname.startsWith("/auth/v1/logout")) return send(res, 204);
  if (url.pathname.startsWith("/storage/v1/")) return storage(req, res, url, user).catch((e) => send(res, 500, { message: e.message }));
  const m = url.pathname.match(/^\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
  if (!m) return send(res, 404, { message: "not implemented in local-api" });
  const S = schemaOf(req);
  if (!S) return send(res, 406, { code: "PGRST106", message: "schema not exposed" });
  let body = "";
  for await (const c of req) body += c;
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(`set local role ${user ? "authenticated" : "anon"}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user?.sub ?? ""]);
    let out;
    const headers = {};
    if (m[1]) out = await rpc(db, S, m[2], body ? JSON.parse(body) : {});
    else if (req.method === "GET" || req.method === "HEAD") {
      const wantCount = /count=exact/.test(req.headers.prefer ?? "");
      const r = await select(db, S, m[2], url.searchParams, wantCount);
      out = r.rows;
      if (wantCount) headers["content-range"] = `${r.rows.length ? `0-${r.rows.length - 1}` : "*"}/${r.count}`;
      if (/vnd\.pgrst\.object/.test(req.headers.accept ?? "")) {
        if (r.rows.length !== 1) { await db.query("rollback"); return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }); }
        out = r.rows[0];
      }
    } else { await db.query("rollback"); return send(res, 405, { message: "clients may only read tables; writes go through functions" }); }
    await db.query("commit");
    return req.method === "HEAD" ? send(res, 200, undefined, headers) : send(res, 200, out, headers);
  } catch (e) {
    await db.query("rollback").catch(() => {});
    return send(res, 400, { code: e.code ?? "P0001", message: e.message, details: e.detail ?? null, hint: e.hint ?? null });
  } finally { db.release(); }
}).listen(54321, "127.0.0.1", () => console.log("local-api on http://127.0.0.1:54321"));
