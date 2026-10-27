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
const jst = (d, t) => new Date(d + "T" + t + ":00+09:00").getTime();
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
    for (const [id, u] of Object.entries(users)) {
      if (!u.c) { u.c = Date.now(); await redis(["HSET", "club:users", id, JSON.stringify(u)]); }
    }

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
      users[id] = { name, salt, hash: hashPw(pw, salt), c: Date.now() };
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

    if (b.a === "setg") {
      if (!admin) return err(res, 401, "権限がありません");
      if (users[b.id] && ["m", "f", ""].includes(b.g)) {
        users[b.id].g = b.g;
        await redis(["HSET", "club:users", b.id, JSON.stringify(users[b.id])]);
      }
    }

    if (b.a === "vote") {
      const byAdmin = admin && b.uid;
      const target = byAdmin ? b.uid : me;
      if (!target || !users[target]) return err(res, 401, "ログインしてください");
      if (!cfg.days[b.date]) return err(res, 400, "練習日ではありません");
      const cur = JSON.parse((await redis(["HGET", "club:votes", target])) || "{}");
      const now = Date.now(), old = cur[b.date] || {};
      // 本人の変更が練習開始後なら印を付ける（一度付いたら外れない）。管理者による修正では新たに付けない
      const x = byAdmin ? !!old.x : !!old.x || now >= jst(b.date, cfg.days[b.date].s);
      const t = byAdmin ? old.t || now : now;
      const r = String(b.r || "").slice(0, 100);
      if (STATUS.includes(b.s)) cur[b.date] = { s: b.s, r, t, x };
      else if (x) cur[b.date] = { s: "", r: "", t, x: true };
      else delete cur[b.date];
      await redis(["HSET", "club:votes", target, JSON.stringify(cur)]);
    }

    const level = admin ? 2 : me ? 1 : 0;
    const out = { level, cfg: { days: cfg.days, ds: cfg.ds, de: cfg.de }, name: me ? users[me].name : "" };
    if (token) out.token = token;
    if (level >= 1) {
      const flat = (await redis(["HGETALL", "club:votes"])) || [];
      const votes = {}, att = {};
      for (let i = 0; i < flat.length; i += 2) if (users[flat[i]]) votes[flat[i]] = JSON.parse(flat[i + 1]);
      const chg = {};
      for (const [uid, v] of Object.entries(votes))
        for (const [d, x] of Object.entries(v)) {
          if (!cfg.days[d]) continue;
          if (STATUS.includes(x.s)) (att[d] = att[d] || {})[uid] = x.s;
          if (x.x) (chg[d] = chg[d] || {})[uid] = level === 2 ? x.t || 1 : 1; // 時刻は管理者にのみ送る
        }
      out.att = att;
      out.chg = chg;
      out.mine = me ? votes[me] || {} : {};
      out.roster = Object.entries(users)
        .map(([id, u]) => ({ id, name: u.name, g: u.g || "" }))
        .sort((a, b) => a.name.localeCompare(b.name, "ja"));
      if (level === 2) {
        out.votes = votes;
        // 連続欠席回数：終了済みの練習を日付順に見て、参加・遅刻・早退なら0、不参加・未回答なら+1
        const days = Object.keys(cfg.days).sort(), now = Date.now(), streak = {};
        for (const [uid, u] of Object.entries(users)) {
          let n = 0;
          for (const d of days) {
            const { s, e } = cfg.days[d];
            if (jst(d, e) > now || jst(d, s) < (u.c || 0)) continue;
            const st = ((votes[uid] || {})[d] || {}).s || "";
            n = ["in", "late", "early"].includes(st) ? 0 : n + 1;
          }
          streak[uid] = n;
        }
        out.streak = streak;
      }
    }
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ msg: "サーバーでエラーが発生しました" });
  }
};
