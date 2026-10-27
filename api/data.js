const crypto = require("crypto");
const U = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const T = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = async (cmd) => {
  const r = await fetch(U, { method: "POST", headers: { Authorization: "Bearer " + T }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
};
const clean = (s) => String(s || "").trim();
const same = (a, b) => {
  if (!a || !b) return false;
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const sign = (id, u) =>
  id + "." + crypto.createHmac("sha256", clean(process.env.ADMIN_PASSWORD)).update(id + "|" + u.hash).digest("hex");
const TIME = /^\d\d:\d\d$/, DATE = /^\d{4}-\d\d-\d\d$/, STATUS = ["in", "late", "early", "out"];
const err = (res, code, msg) => res.status(code).json({ msg });

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  if (!clean(process.env.ADMIN_PASSWORD)) return err(res, 500, "サーバーの設定が不足しています");
  const b = req.body || {};
  try {
    const admin = same(clean(b.admin), clean(process.env.ADMIN_PASSWORD));
    let cfg = JSON.parse((await redis(["GET", "club:cfg"])) || "null") || { days: {}, ds: "17:00", de: "19:00" };
    const uflat = (await redis(["HGETALL", "club:users"])) || [];
    const users = {};
    for (let i = 0; i < uflat.length; i += 2) users[uflat[i]] = JSON.parse(uflat[i + 1]);

    let me = "", token = "";
    const [tid] = String(b.token || "").split(".");
    if (users[tid] && same(b.token, sign(tid, users[tid]))) me = tid;

    if (b.a === "register") {
      if (!same(clean(b.code), clean(process.env.MEMBER_CODE))) return err(res, 401, "部員パスコードが違います");
      const name = clean(b.name).slice(0, 20), pw = String(b.pw || "");
      if (!name || pw.length < 4) return err(res, 400, "表示名と、4文字以上のパスワードを入力してください");
      if (Object.values(users).some((u) => u.name.toLowerCase() === name.toLowerCase()))
        return err(res, 400, "その表示名はすでに使われています");
      const id = "u" + crypto.randomBytes(6).toString("hex"), salt = crypto.randomBytes(16).toString("hex");
      users[id] = { name, salt, hash: hashPw(pw, salt) };
      await redis(["HSET", "club:users", id, JSON.stringify(users[id])]);
      me = id; token = sign(id, users[id]);
    }

    if (b.a === "login") {
      const name = clean(b.name).toLowerCase(), fk = "club:fail:" + name.slice(0, 40);
      if (+((await redis(["GET", fk])) || 0) >= 10) return err(res, 429, "試行回数が多すぎます。10分後にもう一度お試しください");
      const e = Object.entries(users).find(([, u]) => u.name.toLowerCase() === name);
      if (!e || !same(hashPw(String(b.pw || ""), e[1].salt), e[1].hash)) {
        await redis(["INCR", fk]); await redis(["EXPIRE", fk, 600]);
        return err(res, 401, "表示名またはパスワードが違います");
      }
      await redis(["DEL", fk]);
      me = e[0]; token = sign(e[0], e[1]);
    }

    if (b.a === "save") {
      if (!admin) return err(res, 401, "権限がありません");
      const c = b.cfg || {}, days = {};
      for (const [k, v] of Object.entries(c.days || {})) {
        if (DATE.test(k) && v && TIME.test(v.s) && TIME.test(v.e)) days[k] = { s: v.s, e: v.e };
      }
      cfg = { days, ds: TIME.test(c.ds) ? c.ds : "17:00", de: TIME.test(c.de) ? c.de : "19:00" };
      await redis(["SET", "club:cfg", JSON.stringify(cfg)]);
    }

    if (b.a === "deluser") {
      if (!admin) return err(res, 401, "権限がありません");
      if (users[b.id]) {
        await redis(["HDEL", "club:users", b.id]);
        await redis(["HDEL", "club:votes", b.id]);
        delete users[b.id];
        if (me === b.id) me = "";
      }
    }

    if (b.a === "vote") {
      if (!me) return err(res, 401, "ログインしてください");
      if (!cfg.days[b.date]) return err(res, 400, "練習日ではありません");
      const cur = JSON.parse((await redis(["HGET", "club:votes", me])) || "{}");
      if (STATUS.includes(b.s)) cur[b.date] = { s: b.s, r: String(b.r || "").slice(0, 100) };
      else delete cur[b.date];
      await redis(["HSET", "club:votes", me, JSON.stringify(cur)]);
    }

    const level = admin ? 2 : me ? 1 : 0;
    const out = { level, cfg: { days: cfg.days, ds: cfg.ds, de: cfg.de }, name: me ? users[me].name : "" };
    if (token) out.token = token;
    if (level >= 1) {
      const flat = (await redis(["HGETALL", "club:votes"])) || [];
      const votes = {};
      for (let i = 0; i < flat.length; i += 2) if (users[flat[i]]) votes[flat[i]] = JSON.parse(flat[i + 1]);
      const counts = {};
      for (const d of Object.keys(cfg.days)) counts[d] = { in: 0, late: 0, early: 0, out: 0 };
      for (const v of Object.values(votes)) for (const [d, x] of Object.entries(v)) if (counts[d] && counts[d][x.s] !== undefined) counts[d][x.s]++;
      out.counts = counts;
      out.mine = me ? votes[me] || {} : {};
      if (level === 2) {
        out.votes = votes;
        out.members = Object.entries(users).map(([id, u]) => ({ id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name, "ja"));
      }
    }
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ msg: "サーバーでエラーが発生しました" });
  }
};
