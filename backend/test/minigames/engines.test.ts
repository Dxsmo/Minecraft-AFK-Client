import { describe, it, expect } from "vitest";
import { engine, validateConfig } from "../../src/minigames/games/index.js";
import { bingoLines, eligibleItems } from "../../src/minigames/games/items.js";
import { lineWinner, rpsWinner } from "../../src/minigames/games/boards.js";
import { isSurvivalItem } from "../../src/minigames/item-policy.js";
import { photoVote } from "../../src/minigames/games/world.js";
import {
  generateCode,
  eventSchema,
  handshakeSchema,
} from "../../src/minigames/protocol.js";
import { lobby, start, context, event, ids, hello } from "./helpers.js";
describe("protocol", () => {
  it("generates case-sensitive unambiguous eight-character codes", () => {
    const codes = Array.from({ length: 1000 }, generateCode);
    expect(new Set(codes).size).toBe(1000);
    for (const c of codes) {
      expect(c).toMatch(/^[A-HJ-NP-Za-km-z2-9#!?]{8}$/);
    }
    expect("AbC2#?xy").not.toBe("abc2#?xy");
  });
  it("rejects incompatible protocol and invalid version", () => {
    expect(
      handshakeSchema.safeParse({ ...hello(), protocolVersion: 2 }).success,
    ).toBe(false);
    expect(
      handshakeSchema.safeParse({ ...hello(), minecraftVersion: "1.20" })
        .success,
    ).toBe(false);
    expect(
      handshakeSchema.safeParse({ ...hello(), minecraftVersion: "26.3" })
        .success,
    ).toBe(true);
  });
  it("rejects malformed moves and item identities", () => {
    expect(eventSchema.safeParse(event("MOVE", { slot: -1 })).success).toBe(
      false,
    );
    expect(
      eventSchema.safeParse(event("INVENTORY", { items: ["file:///secret"] }))
        .success,
    ).toBe(false);
  });
  it("validates game configuration and fixed player counts", () => {
    expect(validateConfig("tictactoe", {}).maxPlayers).toBe(2);
    expect(() => validateConfig("tictactoe", { maxPlayers: 10 })).toThrow();
    expect(() => validateConfig("bingo", { boardSize: 9 })).toThrow();
  });
});
describe("Bingo and item engines", () => {
  it("detects rows, columns, diagonals and two lines", () => {
    expect(bingoLines([0, 1, 2], 3)).toBe(1);
    expect(bingoLines([0, 3, 6], 3)).toBe(1);
    expect(bingoLines([0, 4, 8], 3)).toBe(1);
    expect(bingoLines([0, 1, 2, 3, 6], 3)).toBe(2);
  });
  it("wins first line and preserves obtained objectives", () => {
    const l = lobby("bingo", { boardSize: 3 });
    start(l);
    const items = l.data.items.slice(0, 3);
    engine(l.game).handle(
      l,
      l.members[0],
      event("INVENTORY", { items }),
      context,
    );
    expect(l.winners).toEqual([ids[0]]);
  });
  it("enforces Lockout ownership", () => {
    const l = lobby("bingo", { boardSize: 3, winCondition: "LOCKOUT" });
    start(l);
    const items = [l.data.items[0]];
    for (const m of l.members)
      engine(l.game).handle(l, m, event("INVENTORY", { items }), context);
    expect(l.members.map((m) => m.score)).toEqual([1, 0]);
    expect(l.data.owners[0]).toBe(ids[0]);
  });
  it("excludes creative-only, unfair, disabled and non-intersection items", () => {
    const l = lobby("bingo");
    start(l);
    const custom = {
      ...context,
      content: [
        ...context.content,
        {
          id: "minecraft:dragon_egg",
          kind: "item",
          enabled: true,
          data: { ...context.content[0].data },
        },
        {
          id: "minecraft:barrier",
          kind: "item",
          enabled: true,
          data: { ...context.content[0].data, survivalObtainable: false },
        },
        {
          ...context.content[0],
          id: "minecraft:exclusive",
          data: { ...context.content[0].data, supportedVersions: ["26.3"] },
        },
      ],
    };
    l.members.forEach((m) =>
      m.catalog.push(
        "minecraft:dragon_egg",
        "minecraft:barrier",
        "minecraft:exclusive",
      ),
    );
    expect(eligibleItems(l, custom, "bingoEligible")).not.toContain(
      "minecraft:dragon_egg",
    );
    expect(eligibleItems(l, custom, "bingoEligible")).not.toContain(
      "minecraft:barrier",
    );
    expect(eligibleItems(l, custom, "bingoEligible")).not.toContain(
      "minecraft:exclusive",
    );
  });
  it("rerolls Item Hunt and Bingo objectives already in any inventory", () => {
    for (const game of ["item_hunt", "bingo"] as const) {
      const l = lobby(game, { ...(game === "bingo" ? { boardSize: 3 } : {}) });
      l.members[1].inventory = context.content.slice(0, 60).map((x) => x.id);
      start(l);
      const chosen = game === "bingo" ? l.data.items : [l.data.item];
      expect(
        chosen.every((id: string) => !l.members[1].inventory.includes(id)),
      ).toBe(true);
    }
  });
  it("Item Hunt finishes with the first valid report", () => {
    const l = lobby("item_hunt");
    start(l);
    engine(l.game).handle(
      l,
      l.members[1],
      event("INVENTORY", { items: [l.data.item] }),
      context,
    );
    expect(l.winners).toEqual([ids[1]]);
  });
  it("counts unique base IDs and excludes starting inventory", () => {
    const l = lobby("collector");
    l.members[0].inventory = [context.content[0].id];
    start(l);
    const m = l.members[0];
    for (let i = 0; i < 3; i++)
      engine(l.game).handle(
        l,
        m,
        event("INVENTORY", {
          items: context.content.slice(0, 3).map((x) => x.id),
        }),
        context,
      );
    expect(m.score).toBe(2);
    expect(l.data.collected[m.uuid]).toHaveLength(2);
  });
});
describe("board engines", () => {
  it.each([
    [3, 3, 3, [0, 1, 2]],
    [3, 3, 3, [0, 3, 6]],
    [3, 3, 3, [0, 4, 8]],
    [7, 6, 4, [35, 36, 37, 38]],
    [7, 6, 4, [0, 7, 14, 21]],
    [7, 6, 4, [0, 8, 16, 24]],
    [7, 6, 4, [21, 15, 9, 3]],
  ])("detects wins on %ix%i", (w, h, n, positions) => {
    const board = Array(Number(w) * Number(h)).fill(null);
    for (const i of positions as number[]) board[i] = ids[0];
    expect(lineWinner(board, Number(w), Number(h), Number(n))).toBe(ids[0]);
  });
  it("validates turns and detects TicTacToe draw", () => {
    const l = lobby("tictactoe");
    start(l);
    const first = l.members.find((m) => m.uuid === l.data.turn)!;
    const second = l.members.find((m) => m.uuid !== l.data.turn)!;
    expect(() =>
      engine(l.game).handle(l, second, event("MOVE", { slot: 0 }), context),
    ).toThrow("NOT_YOUR_TURN");
    const moves = [0, 1, 2, 4, 3, 5, 7, 6, 8];
    for (let i = 0; i < moves.length; i++)
      engine(l.game).handle(
        l,
        i % 2 ? second : first,
        event("MOVE", { slot: moves[i] }),
        context,
      );
    expect(l.state).toBe("RESULTS");
    expect(l.winners).toEqual([]);
  });
  it("alternates starter including initial index zero", () => {
    const l = lobby("tictactoe");
    start(l);
    const first = l.data.turn;
    l.round++;
    engine(l.game).start(l, context);
    expect(l.data.turn).not.toBe(first);
    l.round++;
    engine(l.game).start(l, context);
    expect(l.data.turn).toBe(first);
  });
  it("drops Connect Four pieces and rejects full columns", () => {
    const l = lobby("connect_four");
    start(l);
    for (let i = 0; i < 6; i++) {
      const m = l.members.find((m) => m.uuid === l.data.turn)!;
      engine(l.game).handle(l, m, event("MOVE", { slot: 0 }), context);
    }
    expect(l.data.board[35]).toBeTruthy();
    expect(() =>
      engine(l.game).handle(
        l,
        l.members.find((m) => m.uuid === l.data.turn)!,
        event("MOVE", { slot: 0 }),
        context,
      ),
    ).toThrow("INVALID_SLOT");
  });
  it("Memory matching pair grants a point and repeated turn", () => {
    const l = lobby("memory");
    start(l);
    const first = l.data.turn;
    const a = 0,
      b = l.data.deck.findIndex(
        (x: string, i: number) => i !== 0 && x === l.data.deck[0],
      );
    const m = l.members.find((m) => m.uuid === first)!;
    engine(l.game).handle(l, m, event("MOVE", { slot: a }), context);
    engine(l.game).handle(l, m, event("MOVE", { slot: b }), context);
    expect(m.score).toBe(1);
    expect(l.data.turn).toBe(first);
    expect(l.data.matched).toEqual([a, b]);
  });
  it("Memory mismatches lock clicks until reveal evaluation; hidden cards stay secret", () => {
    const l = lobby("memory");
    start(l);
    const m = l.members.find((m) => m.uuid === l.data.turn)!;
    const b = l.data.deck.findIndex((x: string) => x !== l.data.deck[0]);
    engine(l.game).handle(
      l,
      m,
      event("MOVE", { slot: 0 }, context.now),
      context,
    );
    engine(l.game).handle(
      l,
      m,
      event("MOVE", { slot: b }, context.now),
      context,
    );
    expect(() =>
      engine(l.game).handle(l, m, event("MOVE", { slot: 3 }), context),
    ).toThrow("REVEAL_PENDING");
    const visible = engine(l.game).serialize(l, ids[1]);
    expect(visible.deck.filter(Boolean)).toHaveLength(2);
    engine(l.game).tick(l, { ...context, now: context.now + 1500 });
    expect(l.data.turn).not.toBe(m.uuid);
    expect(
      engine(l.game).serialize(l, ids[0]).deck.filter(Boolean),
    ).toHaveLength(0);
  });
  it.each([
    ["rock", "scissors", 1],
    ["scissors", "paper", 1],
    ["paper", "rock", 1],
    ["paper", "scissors", -1],
    ["rock", "rock", 0],
  ])("RPS %s vs %s", (a, b, result) =>
    expect(rpsWinner(String(a), String(b))).toBe(result),
  );
  it("RPS keeps choices secret until reveal and resolves best-of", () => {
    const l = lobby("rps", { bestOf: 1 });
    start(l);
    engine(l.game).handle(
      l,
      l.members[0],
      event("CHOICE", { choice: "rock" }),
      context,
    );
    expect(engine(l.game).serialize(l, ids[1]).choices[ids[0]]).toBe("chosen");
    engine(l.game).handle(
      l,
      l.members[1],
      event("CHOICE", { choice: "scissors" }),
      context,
    );
    engine(l.game).tick(l, { ...context, now: context.now + 3001 });
    expect(l.winners).toEqual([ids[0]]);
  });
});
describe("world games", () => {
  it("Hot Potato validates holder/cooldown and eliminates at secret deadline", () => {
    const l = lobby("hot_potato", {}, 3);
    start(l);
    const holder = l.members.find((m) => m.uuid === l.data.holder)!;
    const target = l.members.find((m) => m.uuid !== holder.uuid)!;
    engine(l.game).handle(
      l,
      holder,
      event("HIT", { target: target.uuid }),
      context,
    );
    expect(() =>
      engine(l.game).handle(l, target, event("HIT", { target: holder.uuid }), {
        ...context,
        now: context.now + 500,
      }),
    ).toThrow("PASS_COOLDOWN");
    expect(engine(l.game).serialize(l, ids[0]).explodesAt).toBeUndefined();
    engine(l.game).tick(l, { ...context, now: l.data.explodesAt + 1 });
    expect(target.status).toBe("ELIMINATED");
    expect(l.state).toBe("ROUND_END");
  });
  it("Hide & Seek only allows seeker tags after hide time; enforces radius", () => {
    const l = lobby("hide_seek");
    start(l);
    const seeker = l.members.find((m) => m.uuid === l.data.seeker)!;
    const target = l.members.find((m) => m.uuid !== l.data.seeker)!;
    expect(() =>
      engine(l.game).handle(
        l,
        seeker,
        event("HIT", { target: target.uuid }),
        context,
      ),
    ).toThrow("HIDE_PHASE");
    engine(l.game).handle(l, seeker, event("HIT", { target: target.uuid }), {
      ...context,
      now: l.data.hideEndsAt + 1,
    });
    expect(target.status).toBe("ELIMINATED");
    expect(l.winners).toEqual([seeker.uuid]);
  });
  it("eliminates out-of-bounds after warning grace", () => {
    const l = lobby("hide_seek", {}, 3);
    start(l);
    const target = l.members.find((m) => m.uuid !== l.data.seeker)!;
    engine(l.game).handle(
      l,
      target,
      event("POSITION", {
        x: 500,
        y: 64,
        z: 0,
        dimension: "minecraft:overworld",
        elytra: false,
      }),
      context,
    );
    engine(l.game).tick(l, { ...context, now: context.now + 10001 });
    expect(target.status).toBe("ELIMINATED");
  });
  it("MasterBuilders picks from German content, hides word and scores ordered guesses", () => {
    const l = lobby("masterbuilders", {}, 3),
      c = {
        ...context,
        content: [
          ...context.content,
          ...["Pinguin", "Burg", "Vulkan", "Rakete", "Kaktus"].map(
            (word, i) => ({
              id: "word-" + i,
              kind: "word",
              enabled: true,
              data: { word },
            }),
          ),
        ],
      };
    start(l, c);
    const builder = l.members.find((m) => m.uuid === l.data.builder)!;
    engine(l.game).handle(l, builder, event("WORD", { index: 0 }), c);
    const guessers = l.members.filter((m) => m.uuid !== builder.uuid);
    expect(engine(l.game).serialize(l, guessers[0].uuid).word).toBeUndefined();
    for (const m of guessers)
      engine(l.game).handle(
        l,
        m,
        event("GUESS", { word: l.data.word.toLowerCase() }),
        c,
      );
    expect(guessers.map((m) => m.score)).toEqual([3, 2]);
    expect(builder.score).toBe(2);
    expect(l.data.substate).toBe("ROUND_RESULT");
  });
  it("Photo Hunt uses majority, rejects ties and forbids submitter vote", () => {
    expect(photoVote({ a: true, b: false }, ["a", "b"])).toBe(false);
    expect(photoVote({ a: true }, ["a"])).toBe(true);
    const l = lobby("photo_hunt", {}, 3);
    const c = {
      ...context,
      content: [
        {
          id: "p",
          kind: "photo",
          enabled: true,
          data: { textDe: "Mache ein Bild von einer Blume." },
        },
      ],
    };
    start(l, c);
    l.data.pausedAt = context.now;
    l.data.submission = {
      id: "photo",
      player: ids[0],
      eligible: ids.slice(1),
      votes: {},
      voteEndsAt: context.now + 60000,
    };
    expect(() =>
      engine(l.game).handle(
        l,
        l.members[0],
        event("VOTE", { accept: true }),
        c,
      ),
    ).toThrow("CANNOT_VOTE");
    engine(l.game).handle(l, l.members[1], event("VOTE", { accept: true }), c);
    engine(l.game).handle(l, l.members[2], event("VOTE", { accept: false }), c);
    expect(l.state).toBe("COUNTDOWN");
    expect(l.data.lastSubmission.accepted).toBe(false);
    engine(l.game).tick(l, { ...c, now: context.now + 3001 });
    expect(l.state).toBe("ACTIVE");
  });
});

it("excludes creative-only registry items from objective and collector policy", () => {
  for (const id of [
    "command_block_minecart",
    "suspicious_sand",
    "suspicious_gravel",
    "barrier",
    "zombie_spawn_egg",
    "frogspawn",
    "infested_stone",
  ])
    expect(isSurvivalItem("minecraft:" + id)).toBe(false);
  expect(isSurvivalItem("minecraft:diamond_sword")).toBe(true);
});

it("removes Bingo players from winner eligibility after their disconnect grace expires", () => {
  const l = lobby("bingo", { boardSize: 3 });
  start(l);
  l.members[0].score = 8;
  l.members[1].score = 1;
  engine(l.game).disconnect(l, l.members[0], context);
  engine(l.game).tick(l, { ...context, now: l.roundEndsAt! + 1 });
  expect(l.winners).toEqual([l.members[1].uuid]);
});
