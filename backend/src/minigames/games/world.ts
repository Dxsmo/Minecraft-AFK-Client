import { z } from "zod";
import {
  active,
  ensure,
  finish,
  random,
  shuffle,
  metric,
  type Lobby,
  type Member,
} from "../protocol.js";
import {
  baseConfig,
  defaults,
  register,
  timed,
  type Context,
} from "./registry.js";
function newPotato(l: Lobby, c: Context) {
  const players = active(l);
  if (players.length <= 1) {
    finish(
      l,
      players.map((m) => m.uuid),
    );
    return;
  }
  l.state = "ACTIVE";
  l.data.holder = random(players).uuid;
  l.data.explodesAt = c.now + 15000 + Math.floor(Math.random() * 30000);
  l.data.lastPassAt = 0;
  l.data.nextPulseAt = c.now;
  metric(l.members.find((m) => m.uuid === l.data.holder)!, "timesReceived");
}
register({
  ...defaults,
  id: "hot_potato",
  icon: "minecraft:potato",
  minPlayers: 2,
  maxPlayers: 10,
  usesTimer: false,
  usesGameScreen: false,
  settings: z.object(baseConfig).strict(),
  start: newPotato,
  handle(l, m, e, c) {
    ensure(e.type === "HIT", "UNSUPPORTED_EVENT");
    ensure(l.data.holder === m.uuid, "NOT_HOLDER");
    ensure(c.now - l.data.lastPassAt >= 750, "PASS_COOLDOWN");
    const t = active(l).find((t) => t.uuid === e.target);
    ensure(
      t && t.uuid !== m.uuid && t.connection === "CONNECTED",
      "INVALID_TARGET",
    );
    l.data.holder = t.uuid;
    l.data.lastPassAt = c.now;
    metric(m, "successfulPasses");
    metric(t, "timesReceived");
  },
  tick(l, c) {
    if (l.data.nextRoundAt) {
      if (c.now >= l.data.nextRoundAt) {
        delete l.data.nextRoundAt;
        newPotato(l, c);
      }
      return;
    }
    if (
      l.members.find((m) => m.uuid === l.data.holder)?.connection !==
      "CONNECTED"
    ) {
      l.data.explodesAt += 500;
      return;
    }
    if (c.now >= l.data.explodesAt) {
      const m = l.members.find((m) => m.uuid === l.data.holder);
      if (m) {
        m.status = "ELIMINATED";
        metric(m, "eliminations");
      }
      l.data.exploded = l.data.holder;
      delete l.data.holder;
      if (active(l).length <= 1)
        finish(
          l,
          active(l).map((m) => m.uuid),
        );
      else {
        l.state = "ROUND_END";
        l.data.nextRoundAt = c.now + 3000;
      }
    }
  },
  disconnect(l, m, c) {
    m.status = "ELIMINATED";
    if (l.data.holder === m.uuid) newPotato(l, c);
    else if (active(l).length <= 1)
      finish(
        l,
        active(l).map((m) => m.uuid),
      );
  },
  serialize(l) {
    const d = structuredClone(l.data);
    delete d.explodesAt;
    delete d.nextPulseAt;
    return d;
  },
});
function endSeek(l: Lobby) {
  const hiders = active(l).filter((m) => m.uuid !== l.data.seeker);
  finish(l, hiders.length ? hiders.map((m) => m.uuid) : [l.data.seeker]);
}
register({
  ...defaults,
  id: "hide_seek",
  icon: "minecraft:oak_leaves",
  minPlayers: 2,
  maxPlayers: 10,
  usesTimer: true,
  usesGameScreen: false,
  settings: z
    .object({
      ...baseConfig,
      hideSeconds: z.number().int().min(5).max(300).default(30),
      radius: z.number().int().min(10).max(2000).default(100),
      allowElytra: z.boolean().default(false),
      allowDimension: z.boolean().default(false),
      hints: z.boolean().default(false),
    })
    .strict(),
  prepare(l) {
    ensure(
      l.members.every((m) => m.position),
      "POSITION_REQUIRED",
    );
  },
  start(l, c) {
    this.prepare(l, c);
    const seeker = random(l.members);
    metric(seeker, "timesSeeker");
    l.data = {
      seeker: seeker.uuid,
      hideEndsAt: c.now + Number(l.config.hideSeconds) * 1000,
      center: structuredClone(
        l.members.find((m) => m.uuid === l.host)!.position,
      ),
      outside: {},
    };
    timed(l, l.data.hideEndsAt);
  },
  handle(l, m, e, c) {
    if (e.type === "HIT") {
      ensure(c.now >= l.data.hideEndsAt, "HIDE_PHASE");
      ensure(m.uuid === l.data.seeker, "NOT_SEEKER");
      const t = active(l).find(
        (t) => t.uuid === e.target && t.uuid !== l.data.seeker,
      );
      ensure(t && t.connection === "CONNECTED", "INVALID_TARGET");
      t.status = "ELIMINATED";
      metric(m, "playersFound");
      if (!active(l).some((m) => m.uuid !== l.data.seeker)) endSeek(l);
    } else if (e.type === "POSITION") {
      const p = l.data.center;
      const outside =
        Math.hypot(e.x - p.x, e.z - p.z) > Number(l.config.radius) ||
        (!l.config.allowDimension && e.dimension !== p.dimension) ||
        (!l.config.allowElytra && e.elytra);
      if (outside) l.data.outside[m.uuid] ??= c.now + 10000;
      else delete l.data.outside[m.uuid];
    } else ensure(false, "UNSUPPORTED_EVENT");
  },
  tick(l, c) {
    for (const m of active(l))
      if (
        m.connection === "CONNECTED" &&
        c.now >= (l.data.outside[m.uuid] ?? Infinity)
      )
        m.status = "ELIMINATED";
    if (
      !active(l).some((m) => m.uuid === l.data.seeker) ||
      !active(l).some((m) => m.uuid !== l.data.seeker) ||
      c.now >= (l.roundEndsAt ?? Infinity)
    ) {
      for (const m of active(l).filter((m) => m.uuid !== l.data.seeker))
        metric(m, "timesHiddenSuccessfully");
      endSeek(l);
    }
    if (l.config.hints && c.now >= l.data.hideEndsAt)
      l.data.hints = active(l)
        .filter((m) => m.uuid !== l.data.seeker && m.position)
        .map((m) => ({
          uuid: m.uuid,
          distance:
            Math.round(
              Math.hypot(
                m.position!.x -
                  l.members.find((m) => m.uuid === l.data.seeker)!.position!.x,
                m.position!.z -
                  l.members.find((m) => m.uuid === l.data.seeker)!.position!.z,
              ) / 10,
            ) * 10,
        }));
  },
  reconnect(l, m) {
    if (l.data.outside) delete l.data.outside[m.uuid];
  },
  disconnect(l, m) {
    m.status = "ELIMINATED";
    if (
      m.uuid === l.data.seeker ||
      !active(l).some((m) => m.uuid !== l.data.seeker)
    )
      endSeek(l);
  },
});
export function normalizeGuess(word: string) {
  return word
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("de-DE")
    .replace(/\s+/g, " ");
}
function builderRound(l: Lobby, c: Context) {
  const index = l.data.builderIndex ?? 0;
  if (index >= l.data.order.length) {
    const high = Math.max(...l.members.map((m) => m.score));
    finish(
      l,
      l.members.filter((m) => m.score === high).map((m) => m.uuid),
    );
    return;
  }
  const pool = shuffle(l.data.wordPool);
  ensure(pool.length >= 5, "INSUFFICIENT_WORDS");
  l.data.builder = l.data.order[index];
  l.data.options = pool.slice(0, 5);
  l.data.substate = "WORD_SELECTION";
  l.data.selectEndsAt = c.now + 10000;
  l.data.guessed = [];
  delete l.data.word;
  l.roundEndsAt = undefined;
  if (!active(l).some((m) => m.uuid === l.data.builder)) {
    l.data.builderIndex++;
    builderRound(l, c);
  }
}
function chooseWord(l: Lobby, index: number, c: Context) {
  l.data.word = l.data.options[index];
  l.data.substate = "BUILDING";
  timed(l, c.now);
}
function nextBuilder(l: Lobby, c: Context) {
  l.data.substate = "ROUND_RESULT";
  l.data.nextAt = c.now + 3000;
  l.roundEndsAt = undefined;
}
register({
  ...defaults,
  id: "masterbuilders",
  icon: "minecraft:scaffolding",
  minPlayers: 2,
  maxPlayers: 10,
  usesTimer: true,
  usesGameScreen: false,
  settings: z.object(baseConfig).strict(),
  start(l, c) {
    l.data = {
      order: shuffle(l.members.map((m) => m.uuid)),
      builderIndex: 0,
      wordPool: c.content
        .filter((x) => x.kind === "word" && x.enabled)
        .map((x) => x.data.word),
    };
    builderRound(l, c);
  },
  handle(l, m, e, c) {
    if (e.type === "WORD") {
      ensure(
        l.data.builder === m.uuid && l.data.substate === "WORD_SELECTION",
        "NOT_SELECTING",
      );
      chooseWord(l, e.index, c);
    } else if (e.type === "GUESS") {
      ensure(
        l.data.substate === "BUILDING" &&
          m.uuid !== l.data.builder &&
          !l.data.guessed.includes(m.uuid),
        "CANNOT_GUESS",
      );
      if (normalizeGuess(e.word) !== normalizeGuess(l.data.word)) return;
      const points =
        l.data.guessed.length === 0 ? 3 : l.data.guessed.length === 1 ? 2 : 1;
      l.data.guessed.push(m.uuid);
      m.score += points;
      metric(m, "correctGuesses");
      metric(m, "guessPoints", points);
      const b = l.members.find((m) => m.uuid === l.data.builder)!;
      b.score++;
      metric(b, "builderPoints");
      if (
        active(l)
          .filter((m) => m.uuid !== l.data.builder)
          .every((m) => l.data.guessed.includes(m.uuid))
      )
        nextBuilder(l, c);
    } else ensure(false, "UNSUPPORTED_EVENT");
  },
  tick(l, c) {
    if (l.data.substate === "WORD_SELECTION" && c.now >= l.data.selectEndsAt)
      chooseWord(l, 0, c);
    else if (
      l.data.substate === "BUILDING" &&
      c.now >= (l.roundEndsAt ?? Infinity)
    )
      nextBuilder(l, c);
    else if (l.data.substate === "ROUND_RESULT" && c.now >= l.data.nextAt) {
      l.data.builderIndex++;
      builderRound(l, c);
    }
  },
  disconnect(l, m, c) {
    m.status = "SPECTATING";
    if (m.uuid === l.data.builder) nextBuilder(l, c);
  },
  serialize(l, uuid) {
    const d = structuredClone(l.data);
    delete d.wordPool;
    if (uuid !== d.builder) {
      delete d.options;
      if (l.state !== "RESULTS") delete d.word;
    }
    return d;
  },
});
export function photoVote(votes: Record<string, boolean>, eligible: string[]) {
  const yes = eligible.filter((id) => votes[id] === true).length;
  return yes > eligible.length / 2;
}
register({
  ...defaults,
  id: "photo_hunt",
  icon: "minecraft:spyglass",
  minPlayers: 2,
  maxPlayers: 10,
  usesTimer: true,
  usesGameScreen: false,
  settings: z.object(baseConfig).strict(),
  start(l, c) {
    l.data = {
      challenge: random(
        c.content.filter((x) => x.kind === "photo" && x.enabled),
      ).data.textDe,
      cooldowns: {},
    };
    timed(l, c.now);
  },
  handle(l, m, e, c) {
    ensure(e.type === "VOTE" && l.data.submission, "NO_SUBMISSION");
    const s = l.data.submission;
    ensure(s.eligible.includes(m.uuid), "CANNOT_VOTE");
    ensure(s.votes[m.uuid] === undefined, "ALREADY_VOTED");
    s.votes[m.uuid] = e.accept;
    if (s.eligible.every((id: string) => s.votes[id] !== undefined))
      resolvePhoto(l, c);
  },
  tick(l, c) {
    if (l.data.submission && c.now >= l.data.submission.voteEndsAt)
      resolvePhoto(l, c);
    else if (l.data.resumeAt && c.now >= l.data.resumeAt) {
      l.roundEndsAt = (l.roundEndsAt ?? c.now) + c.now - l.data.pausedAt;
      delete l.data.resumeAt;
      delete l.data.pausedAt;
      l.state = "ACTIVE";
    } else if (
      !l.data.submission &&
      !l.data.resumeAt &&
      c.now >= (l.roundEndsAt ?? Infinity)
    )
      finish(l, []);
  },
  disconnect(l, m, c) {
    m.status = "SPECTATING";
    if (l.data.submission) {
      l.data.submission.eligible = l.data.submission.eligible.filter(
        (id: string) => id !== m.uuid,
      );
      if (!l.data.submission.eligible.length) resolvePhoto(l, c);
    }
  },
  serialize(l) {
    const d = structuredClone(l.data);
    delete d.cooldowns;
    if (d.submission) delete d.submission.storagePath;
    return d;
  },
});
export function resolvePhoto(l: Lobby, c: Context) {
  const s = l.data.submission;
  const accepted = photoVote(s.votes, s.eligible);
  l.data.lastSubmission = { id: s.id, player: s.player, accepted };
  delete l.data.submission;
  if (accepted) {
    metric(l.members.find((m) => m.uuid === s.player)!, "acceptedSubmissions");
    finish(l, [s.player]);
  } else {
    l.data.cooldowns[s.player] = c.now + 15000;
    l.data.resumeAt = c.now + 3000;
    l.state = "COUNTDOWN";
    l.countdownEndsAt = l.data.resumeAt;
  }
}
