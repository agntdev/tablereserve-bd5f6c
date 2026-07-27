import type { Ctx } from "./bot.js";

export type BookingStatus = "confirmed" | "cancelled" | "no_show";
export interface Table { table_id: string; seats: number }
export interface Booking {
  guest_name: string; telegram_id: number; date: string; time: string; party_size: number;
  tables: string[]; reference_code: string; status: BookingStatus; reminder_sent: boolean;
}
export interface OpeningRules { open_time: string; close_time: string; sitting_length: number; break_periods: Array<{ start: string; end: string }> }
interface RestaurantState { bookings: Booking[]; tables: Table[]; rules: OpeningRules }

const defaults: OpeningRules = { open_time: "11:00", close_time: "22:00", sitting_length: 90, break_periods: [] };
const stateKey = "restaurant:state";

function envOf(ctx: Ctx): Record<string, string | undefined> {
  const worker = (ctx as Ctx & { env?: Record<string, string | undefined> }).env;
  return worker ?? (typeof process === "undefined" ? {} : process.env);
}

function configuredState(env: Record<string, string | undefined>): RestaurantState | undefined {
  const rawTables = env.TABLES_CONFIG;
  if (!rawTables) return undefined;
  try {
    const parsed = JSON.parse(rawTables) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const tables = parsed.map((t, i) => {
      const r = t as Record<string, unknown>;
      return { table_id: String(r.table_id ?? r.id ?? `table-${i + 1}`), seats: Number(r.seats) };
    }).filter((t) => Number.isInteger(t.seats) && t.seats > 0);
    if (!tables.length) return undefined;
    const [open, close] = (env.OPENING_HOURS ?? "11:00-22:00").split("-");
    const sitting = Number(env.SITTING_DURATION ?? "90");
    return { tables, bookings: [], rules: { open_time: validTime(open) ? open : defaults.open_time, close_time: validTime(close) ? close : defaults.close_time, sitting_length: Number.isFinite(sitting) && sitting > 0 ? sitting : defaults.sitting_length, break_periods: [] } };
  } catch { return undefined; }
}

function validTime(v: string | undefined): v is string { return !!v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }

export class RestaurantStore {
  private constructor(private readonly env: Record<string, string | undefined>, private readonly stub?: { fetch(input: string, init?: RequestInit): Promise<Response> }) {}
  static from(ctx: Ctx): RestaurantStore {
    const env = envOf(ctx);
    const chatDo = (env as unknown as { CHAT_DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } } }).CHAT_DO;
    return new RestaurantStore(env, chatDo ? chatDo.get(chatDo.idFromName("restaurant")) : undefined);
  }
  ready(): boolean { return !!this.stub && !!configuredState(this.env); }
  private async load(): Promise<RestaurantState | undefined> {
    const initial = configuredState(this.env);
    if (!this.stub || !initial) return undefined;
    const response = await this.stub.fetch(`https://do/domain?key=${encodeURIComponent(stateKey)}`);
    if (response.status === 204) { await this.save(initial); return initial; }
    return await response.json() as RestaurantState;
  }
  private async save(state: RestaurantState): Promise<void> {
    await this.stub!.fetch(`https://do/domain?key=${encodeURIComponent(stateKey)}`, { method: "PUT", body: JSON.stringify(state) });
  }
  async rules(): Promise<OpeningRules | undefined> { return (await this.load())?.rules; }
  async booking(code: string): Promise<Booking | undefined> { return (await this.load())?.bookings.find((b) => b.reference_code === code); }
  async guestBookings(userId: number): Promise<Booking[]> { return (await this.load())?.bookings.filter((b) => b.telegram_id === userId && b.status === "confirmed") ?? []; }
  async upcoming(): Promise<Booking[]> { return (await this.load())?.bookings.filter((b) => b.status === "confirmed").sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)) ?? []; }
  async availableTables(date: string, time: string, party: number): Promise<Table[]> {
    const state = await this.load(); if (!state || !inService(state.rules, time)) return [];
    const used = new Set(state.bookings.filter((b) => b.status === "confirmed" && b.date === date && overlaps(state.rules, b.time, time)).flatMap((b) => b.tables));
    return state.tables.filter((t) => !used.has(t.table_id) && t.seats >= party);
  }
  async create(input: Omit<Booking, "tables" | "reference_code" | "status" | "reminder_sent">): Promise<Booking | undefined> {
    const state = await this.load(); if (!state) return undefined;
    const table = (await this.availableTables(input.date, input.time, input.party_size))[0];
    if (!table) return undefined;
    const base = `${input.date.replaceAll("-", "").slice(2)}${input.time.replace(":", "")}${input.telegram_id}`;
    let code = base.slice(-6).toUpperCase(); let n = 1;
    while (state.bookings.some((b) => b.reference_code === code)) code = `${base.slice(-4)}${n++}`.slice(-6).toUpperCase();
    const booking: Booking = { ...input, tables: [table.table_id], reference_code: code, status: "confirmed", reminder_sent: false };
    state.bookings.push(booking); await this.save(state); return booking;
  }
  async update(code: string, change: Partial<Pick<Booking, "date" | "time" | "status" | "reminder_sent">>): Promise<Booking | undefined> {
    const state = await this.load(); const b = state?.bookings.find((item) => item.reference_code === code); if (!state || !b) return undefined;
    Object.assign(b, change); await this.save(state); return b;
  }
  async reschedule(code: string, date: string, time: string): Promise<Booking | undefined> {
    const state = await this.load(); const booking = state?.bookings.find((item) => item.reference_code === code);
    if (!state || !booking || booking.status !== "confirmed") return undefined;
    booking.status = "cancelled";
    const table = state.tables.find((t) => t.seats >= booking.party_size && !state.bookings.some((b) => b.status === "confirmed" && b.date === date && b.tables.includes(t.table_id) && overlaps(state.rules, b.time, time)));
    if (!table || !inService(state.rules, time)) { booking.status = "confirmed"; return undefined; }
    booking.date = date; booking.time = time; booking.tables = [table.table_id]; booking.reminder_sent = false; booking.status = "confirmed";
    await this.save(state); return booking;
  }
}

function mins(value: string): number { const [h, m] = value.split(":").map(Number); return h * 60 + m; }
function overlaps(rules: OpeningRules, a: string, b: string): boolean { return Math.abs(mins(a) - mins(b)) < rules.sitting_length; }
export function inService(rules: OpeningRules, time: string): boolean {
  if (!validTime(time)) return false; const value = mins(time); const end = value + rules.sitting_length;
  if (value < mins(rules.open_time) || end > mins(rules.close_time)) return false;
  return !rules.break_periods.some((p) => value < mins(p.end) && end > mins(p.start));
}
