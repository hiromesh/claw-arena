/**
 * auto_play.ts — ClawArena Shrimp-Crab Kill auto-play bot via WebSocket.
 *
 * Usage:
 *   npx ts-node auto_play.ts --api-key arena_xxx --log-file /tmp/game.log [--base-url wss://...]
 *
 * Log file format (JSONL, one JSON object per line):
 *   {"ts":1234,"type":"event",  "data":{...}}              — raw server event
 *   {"ts":1234,"type":"action", "action":"move","payload":{...}} — action sent by bot
 *   {"ts":1234,"type":"status", "status":"meeting_started","message":"..."} — bot state change
 *   {"ts":1234,"type":"error",  "message":"..."}           — errors
 *
 * When phase == "meeting", the bot pauses and writes a "meeting_started" status line.
 * The agent should then handle speech/vote via HTTP and optionally kill this process.
 */

/// <reference types="node" />

import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";
import * as https from "https";
import * as http from "http";

// ─── Config ───────────────────────────────────────────────────────────────────

const DECISION_INTERVAL_MS = 2500; // ms between decision cycles
const HEARTBEAT_INTERVAL_MS = 15000;
const RECONNECT_DELAY_MS = 3000;

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let apiKey = "";
  let logFile = "/tmp/claw_arena_game.log";
  let baseUrl = "wss://clawarena.apps-sl.danlu.netease.com";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api-key")   apiKey  = args[++i];
    if (args[i] === "--log-file")  logFile = args[++i];
    if (args[i] === "--base-url")  baseUrl = args[++i];
  }

  if (!apiKey) {
    console.error("Usage: npx ts-node auto_play.ts --api-key <key> [--log-file <path>] [--base-url <url>]");
    process.exit(1);
  }
  return { apiKey, logFile, baseUrl };
}

// ─── Logger ───────────────────────────────────────────────────────────────────

class Logger {
  private fd: number;

  constructor(logFile: string) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this.fd = fs.openSync(logFile, "a");
  }

  private write(obj: object) {
    fs.writeSync(this.fd, JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  }

  event(data: object)                          { this.write({ type: "event", data }); }
  action(action: string, payload: object)      { this.write({ type: "action", action, payload }); }
  status(status: string, message: string, extra?: object) {
    this.write({ type: "status", status, message, ...extra });
  }
  error(message: string)                       { this.write({ type: "error", message }); }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface You {
  name: string;
  role: string;
  faction: string;       // "lobster" | "crab" | "neutral"
  is_alive: boolean;
  x: number;
  y: number;
  room: string;
  currently_moving: boolean;
  doing_task: boolean;
  remaining_secs: number;
  kill_cooldown_secs?: number;
}

interface TaskInfo  { name: string; x: number; y: number; room: string; status?: string; }
interface PlayerInfo { name: string; x: number; y: number; room: string; }
interface CorpseInfo { name: string; x: number; y: number; room: string; }

interface GameState {
  phase: string;
  you: You;
  your_tasks: TaskInfo[];
  players: PlayerInfo[];
  corpses: CorpseInfo[];
  emergency?: TaskInfo & { remaining_secs: number };
  task_progress?: { completed: number; goal: number };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dist(ax: number, ay: number, bx: number, by: number) {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
}

function nearest<T extends { x: number; y: number }>(from: You, items: T[]): T | null {
  if (!items.length) return null;
  return items.reduce((a, b) =>
    dist(from.x, from.y, a.x, a.y) <= dist(from.x, from.y, b.x, b.y) ? a : b
  );
}

// ─── Decision logic ───────────────────────────────────────────────────────────

/**
 * Decide next action for Lobster faction.
 * TODO: Improve task prioritization (e.g. prefer tasks in safe rooms).
 * TODO: Add logic to avoid known crab locations.
 * TODO: Consider not reporting if you suspect you'll be voted out.
 */
function decideLobster(state: GameState): object {
  const { you, your_tasks, corpses, emergency } = state;

  // TODO: Handle emergency with higher urgency (e.g. sprint)
  if (emergency) {
    if (dist(you.x, you.y, emergency.x, emergency.y) > 20)
      return { action: "move", target_x: emergency.x, target_y: emergency.y };
    return { action: "task", task_name: emergency.name };
  }

  // TODO: Decide whether to report based on game situation
  const nearCorpse = corpses.find(c => dist(you.x, you.y, c.x, c.y) <= 100);
  if (nearCorpse) return { action: "report" };

  // TODO: Prioritize tasks strategically
  const task = nearest(you, your_tasks);
  if (task) {
    if (dist(you.x, you.y, task.x, task.y) > 20)
      return { action: "move", target_x: task.x, target_y: task.y };
    return { action: "task", task_name: task.name };
  }

  return { action: "skip" };
}

/**
 * Decide next action for Crab faction.
 * TODO: Choose kill targets more strategically (e.g. isolated lobsters).
 * TODO: Move away from sabotage site before triggering alarm.
 * TODO: Coordinate with crab teammates if possible.
 */
function decideCrab(state: GameState): object {
  const { you, your_tasks, players } = state;
  const cooldown = you.kill_cooldown_secs ?? 0;

  // TODO: Pick best target (e.g. lowest task progress, most isolated)
  if (cooldown <= 0) {
    const target = players.find(p => p.name !== you.name && dist(you.x, you.y, p.x, p.y) <= 120);
    if (target) return { action: "kill", target: target.name };
  }

  // TODO: Trigger alarm from a safe location after sabotage
  const task = nearest(you, your_tasks);
  if (task) {
    if (dist(you.x, you.y, task.x, task.y) > 20)
      return { action: "move", target_x: task.x, target_y: task.y };
    return { action: "task", task_name: task.name };
  }

  // Chase nearest player when no tasks left
  const target = players.find(p => p.name !== you.name);
  if (target) return { action: "move", target_x: target.x, target_y: target.y };

  return { action: "skip" };
}

/**
 * Decide next action for Neutral faction.
 * TODO: 天堂鱼 — be more actively suspicious to attract votes.
 * TODO: 博比特虫 — survive strategically during Bobbit Worm Time.
 */
function decideNeutral(state: GameState): object {
  const { you, players, corpses } = state;

  // 天堂鱼: wants to be voted out — act suspicious, stay visible
  if (you.role === "neutral_paradise_fish") {
    // TODO: Stand near bodies, move toward groups, act erratically
    const nearCorpse = corpses.find(c => dist(you.x, you.y, c.x, c.y) <= 100);
    if (nearCorpse) return { action: "report" };
    const target = players.find(p => p.name !== you.name);
    if (target && dist(you.x, you.y, target.x, target.y) > 50)
      return { action: "move", target_x: target.x, target_y: target.y };
    return { action: "skip" };
  }

  // 博比特虫: kill when possible, chase otherwise
  if (you.role === "neutral_bobbit_worm") {
    const cooldown = you.kill_cooldown_secs ?? 0;
    if (cooldown <= 0) {
      const target = players.find(p => p.name !== you.name && dist(you.x, you.y, p.x, p.y) <= 120);
      if (target) return { action: "kill", target: target.name };
    }
    const target = players.find(p => p.name !== you.name);
    if (target) return { action: "move", target_x: target.x, target_y: target.y };
  }

  return { action: "skip" };
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

class Bot {
  private ws!: WebSocket;
  private log: Logger;
  private state: GameState | null = null;
  private cachedTasks: TaskInfo[] = [];
  private meetingActive = false;
  private gameOver = false;
  private wsUrl: string;
  private httpBaseUrl: string;

  constructor(private apiKey: string, logFile: string, baseUrl: string) {
    this.log = new Logger(logFile);
    this.wsUrl = `${baseUrl}/api/v1/game/stream?api_key=${apiKey}`;
    this.httpBaseUrl = baseUrl.replace(/^wss?:\/\//, "http://").replace(/^ws:\/\//, "http://");
  }

  start() {
    this.log.status("connecting", `Connecting to ${this.wsUrl}`);
    this.connect();
  }

  private fetchMapInfo(): Promise<void> {
    return new Promise((resolve) => {
      const url = `${this.httpBaseUrl}/api/v1/game/map`;
      const lib = url.startsWith("https") ? https : http;
      const req = lib.get(url, { headers: { Authorization: `Bearer ${this.apiKey}` } }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => body += chunk.toString());
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            if (json.success && json.data?.your_tasks) {
              this.cachedTasks = json.data.your_tasks;
              this.log.status("tasks_loaded", `Loaded ${this.cachedTasks.length} tasks from /game/map`);
            }
          } catch { /* ignore */ }
          resolve();
        });
      });
      req.on("error", () => resolve());
    });
  }

  private connect() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on("open", () => {
      this.log.status("connected", "WebSocket connected");
      setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send("ping");
      }, HEARTBEAT_INTERVAL_MS);
      this.fetchMapInfo().then(() => this.scheduleDecision());
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      const text = raw.toString();
      if (text === "pong") return;
      try {
        const msg = JSON.parse(text);
        this.onMessage(msg);
      } catch {
        this.log.error(`Invalid JSON: ${text}`);
      }
    });

    this.ws.on("close", () => {
      if (this.gameOver) return;
      this.log.error("Disconnected, reconnecting...");
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on("error", (err: Error) => this.log.error(`WS error: ${err.message}`));
  }

  private onMessage(msg: { type: string; [k: string]: unknown }) {
    // Full state snapshot
    if (msg.type === "state") {
      const data = msg.data as any;
      const taskStatusMap: Record<string, string> = {};
      if (Array.isArray(data.your_tasks)) {
        for (const t of data.your_tasks) taskStatusMap[t.name] = t.status;
      }
      const mergedTasks = this.cachedTasks.map(t => ({
        ...t,
        status: taskStatusMap[t.name] ?? t.status ?? "normal",
      })).filter(t => t.status !== "completed");

      this.state = {
        ...data,
        players: data.players ?? data.visible_players ?? [],
        corpses: data.corpses ?? data.nearby_corpses ?? [],
        your_tasks: mergedTasks,
      } as GameState;
      this.syncPhase(this.state.phase);
      return;
    }

    // Event or event batch — log everything
    const events: { type: string; [k: string]: unknown }[] =
      msg.type === "event_batch" ? (msg.data as typeof events) : [msg];

    for (const evt of events) {
      this.log.event(evt);
      this.onEvent(evt);
    }
  }

  private onEvent(evt: { type: string; [k: string]: unknown }) {
    switch (evt.type) {
      case "game_over":
        this.gameOver = true;
        this.log.status("game_over", `Winner: ${evt.winner} — ${evt.reason}`);
        process.exit(0);
        break;
      case "meeting_start":
        this.meetingActive = true;
        this.log.status("meeting_started",
          "Meeting in progress. Bot paused. Handle speech/vote via HTTP API.");
        break;
      case "meeting_ended":
        this.meetingActive = false;
        this.log.status("meeting_ended", "Meeting ended. Bot resuming.");
        break;
      case "task_completed":
        this.cachedTasks = this.cachedTasks.filter(t => t.name !== evt.task_name);
        break;
        this.log.status("role_assigned",
          `Role: ${evt.role_display_name} (${evt.faction}). Goal: ${evt.role_target ?? "?"}`);
        break;
      case "bobbit_time_start":
        this.log.status("bobbit_time", "Bobbit Worm Time! Meetings disabled. Survive 60s to win.");
        break;
      case "win_blocked_by_bobbit":
        this.log.status("win_blocked",
          `${evt.blocked_winner} win blocked by Bobbit Worm (${evt.reason}).`);
        break;
    }
  }

  private syncPhase(phase: string) {
    if (phase === "meeting" && !this.meetingActive) {
      this.meetingActive = true;
      this.log.status("meeting_started",
        "Meeting in progress. Bot paused. Handle speech/vote via HTTP API.");
    } else if (phase === "wandering" && this.meetingActive) {
      this.meetingActive = false;
      this.log.status("meeting_ended", "Meeting ended. Bot resuming.");
    } else if (phase === "game_over") {
      this.gameOver = true;
      this.log.status("game_over", "Game over.");
      process.exit(0);
    }
  }

  private scheduleDecision() {
    setTimeout(() => this.decide(), DECISION_INTERVAL_MS);
  }

  private decide() {
    if (this.gameOver || this.meetingActive || !this.state) {
      this.scheduleDecision();
      return;
    }

    const { you } = this.state;
    if (!you?.is_alive || you.currently_moving || you.doing_task) {
      this.scheduleDecision();
      return;
    }

    let action: object;
    if (you.faction === "lobster")       action = decideLobster(this.state);
    else if (you.faction === "crab")     action = decideCrab(this.state);
    else                                 action = decideNeutral(this.state);

    this.sendAction(action);
    this.scheduleDecision();
  }

  private sendAction(action: object) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const actionName = (action as { action: string }).action;
    this.ws.send(JSON.stringify({ type: "action", data: action }));
    this.log.action(actionName, action);
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const { apiKey, logFile, baseUrl } = parseArgs();
new Bot(apiKey, logFile, baseUrl).start();
