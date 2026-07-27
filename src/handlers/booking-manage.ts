import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";
import { RestaurantStore, type Booking } from "../restaurant-store.js";
import { remindAt } from "../toolkit/session/durable.js";

registerMainMenuItem({ label: "Book a table", data: "booking:new", order: 10 });
registerMainMenuItem({ label: "Manage booking", data: "booking:manage", order: 20 });
registerMainMenuItem({ label: "Owner dashboard", data: "admin:home", order: 30 });

const composer = new Composer<Ctx>();
export let now = (): Date => new Date();
export function setClockForTests(clock: () => Date): void { now = clock; }

const back = inlineKeyboard([[inlineButton("Back to menu", "menu:main")]]);
const setup = "Reservations aren’t set up yet. Ask the restaurant owner to finish the table configuration.";
const label = (b: Booking) => `${b.date} at ${b.time} · ${b.party_size} guests`;
function manageKeys(b: Booking) {
  return inlineKeyboard([[inlineButton("Reschedule", `booking:reschedule:${b.reference_code}`), inlineButton("Cancel booking", `booking:cancel:${b.reference_code}`)], [inlineButton("Back to menu", "menu:main")]]);
}
function owner(ctx: Ctx): boolean {
  const env = (ctx as Ctx & { env?: Record<string, string | undefined> }).env ?? (typeof process === "undefined" ? {} : process.env);
  const ids = [env.OWNER_TELEGRAM_ID, env.ADMIN_CHAT_ID].filter(Boolean);
  return !!ctx.from && ids.includes(String(ctx.from.id));
}
async function sendOwner(ctx: Ctx, text: string): Promise<void> {
  const env = (ctx as Ctx & { env?: Record<string, string | undefined> }).env ?? (typeof process === "undefined" ? {} : process.env);
  const id = env.ADMIN_CHAT_ID ?? env.OWNER_TELEGRAM_ID;
  if (!id) return;
  try { await ctx.api.sendMessage(id, text); } catch { /* A blocked owner must not undo a guest booking. */ }
}
function dates(): string[] { const out: string[] = []; const start = now(); start.setUTCHours(0, 0, 0, 0); for (let i = 0; i < 14; i++) { const day = new Date(start); day.setUTCDate(start.getUTCDate() + i); out.push(day.toISOString().slice(0, 10)); } return out; }
function dateText(date: string): string { return date.slice(5).replace("-", "/"); }
async function scheduleReminder(ctx: Ctx, booking: Booking): Promise<void> {
  const env = (ctx as Ctx & { env?: Parameters<typeof remindAt>[0] }).env;
  if (!env) return;
  const due = Date.parse(`${booking.date}T${booking.time}:00Z`) - 2 * 60 * 60 * 1000;
  if (due <= now().getTime()) return;
  await remindAt(env, booking.telegram_id, due, `Reminder: your table for ${booking.party_size} is at ${booking.time} on ${dateText(booking.date)}.`, manageKeys(booking));
}

composer.callbackQuery("booking:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  const store = RestaurantStore.from(ctx);
  if (!store.ready()) return void await ctx.editMessageText(setup, { reply_markup: back });
  ctx.session.booking = { step: "party" };
  await ctx.editMessageText("How many guests are you booking for?", { reply_markup: inlineKeyboard([[1, 2, 3, 4].map((n) => inlineButton(String(n), `booking:party:${n}`)), [inlineButton("5 guests", "booking:party:5"), inlineButton("6 guests", "booking:party:6")], [inlineButton("Back to menu", "menu:main")]]) });
});

composer.callbackQuery(/^booking:party:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery(); const party = Number(ctx.match[1]);
  if (!Number.isInteger(party) || party < 1 || party > 20) return void await ctx.editMessageText("Choose a party size between 1 and 20.", { reply_markup: back });
  ctx.session.booking = { step: "date", party };
  const rows = dates().map((d) => [inlineButton(dateText(d), `booking:date:${d.replaceAll("-", "")}`)]);
  rows.push([inlineButton("Back to menu", "menu:main")]);
  await ctx.editMessageText("Pick a date in the next two weeks.", { reply_markup: inlineKeyboard(rows) });
});

composer.callbackQuery(/^booking:date:(\d{8})$/, async (ctx) => {
  await ctx.answerCallbackQuery(); const date = `${ctx.match[1].slice(0, 4)}-${ctx.match[1].slice(4, 6)}-${ctx.match[1].slice(6)}`; const party = ctx.session.booking?.party;
  const store = RestaurantStore.from(ctx); if (!party || !store.ready()) return void await ctx.editMessageText(setup, { reply_markup: back });
  const rules = await store.rules(); if (!rules) return void await ctx.editMessageText(setup, { reply_markup: back });
  const slots: string[] = [];
  for (let m = Number(rules.open_time.slice(0, 2)) * 60 + Number(rules.open_time.slice(3)); m < Number(rules.close_time.slice(0, 2)) * 60 + Number(rules.close_time.slice(3)); m += 15) { const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; if ((await store.availableTables(date, time, party)).length) slots.push(time); }
  if (!slots.length) return void await ctx.editMessageText("No tables are free that day for your party. Pick another date.", { reply_markup: inlineKeyboard([[inlineButton("Choose another date", "booking:new")], [inlineButton("Back to menu", "menu:main")]]) });
  ctx.session.booking = { step: "time", party, date };
  const rows = []; for (let i = 0; i < slots.length; i += 3) rows.push(slots.slice(i, i + 3).map((time) => inlineButton(time, `booking:time:${time.replace(":", "")}`)));
  rows.push([inlineButton("Choose another date", "booking:new")]); await ctx.editMessageText(`Available times for ${dateText(date)}:`, { reply_markup: inlineKeyboard(rows) });
});

composer.callbackQuery(/^booking:time:(\d{4})$/, async (ctx) => {
  await ctx.answerCallbackQuery(); const time = `${ctx.match[1].slice(0, 2)}:${ctx.match[1].slice(2)}`; const flow = ctx.session.booking;
  if (!flow?.party || !flow.date) return void await ctx.editMessageText("Start a new booking to choose a time.", { reply_markup: back });
  ctx.session.booking = { ...flow, step: "contact", time };
  await ctx.editMessageText("Use your Telegram contact for this reservation?", { reply_markup: inlineKeyboard([[inlineButton("Use Telegram contact", "booking:contact:telegram")], [inlineButton("Add phone number", "booking:contact:phone")], [inlineButton("Back to menu", "menu:main")]]) });
});

composer.callbackQuery("booking:contact:telegram", async (ctx) => {
  await ctx.answerCallbackQuery(); const flow = ctx.session.booking; const store = RestaurantStore.from(ctx);
  if (!flow?.party || !flow.date || !flow.time || !ctx.from || !store.ready()) return void await ctx.editMessageText("Start a new booking to continue.", { reply_markup: back });
  const booking = flow.code ? await store.reschedule(flow.code, flow.date, flow.time) : await store.create({ guest_name: ctx.from.first_name, telegram_id: ctx.from.id, date: flow.date, time: flow.time, party_size: flow.party });
  if (!booking) return void await ctx.editMessageText("That time was just taken. Pick another time.", { reply_markup: inlineKeyboard([[inlineButton("Choose another date", "booking:new")]]) });
  ctx.session.booking = undefined; await ctx.editMessageText(`You’re booked for ${label(booking)}. Your reference is ${booking.reference_code}.`, { reply_markup: manageKeys(booking) });
  await scheduleReminder(ctx, booking);
  await sendOwner(ctx, `${flow.code ? "Rescheduled" : "New"} booking: ${booking.date} at ${booking.time} for ${booking.party_size} guests. Ref ${booking.reference_code}.`);
});

composer.callbackQuery("booking:contact:phone", async (ctx) => { await ctx.answerCallbackQuery(); const flow = ctx.session.booking; if (!flow) return; ctx.session.booking = { ...flow, step: "phone" }; await ctx.editMessageText("Send your phone number in international format. We’ll use it only for this reservation.", { reply_markup: back }); });

composer.callbackQuery("booking:manage", async (ctx) => {
  await ctx.answerCallbackQuery(); if (!ctx.from) return; const store = RestaurantStore.from(ctx); if (!store.ready()) return void await ctx.editMessageText(setup, { reply_markup: back });
  const bookings = await store.guestBookings(ctx.from.id); if (!bookings.length) return void await ctx.editMessageText("You don’t have an upcoming booking yet — tap Book a table to make one.", { reply_markup: inlineKeyboard([[inlineButton("Book a table", "booking:new")], [inlineButton("Back to menu", "menu:main")]]) });
  await ctx.editMessageText("Choose a booking to manage.", { reply_markup: inlineKeyboard([...bookings.map((b) => [inlineButton(label(b), `booking:open:${b.reference_code}`)]), [inlineButton("Back to menu", "menu:main")]]) });
});

composer.callbackQuery(/^booking:open:([A-Z0-9]+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const b = await RestaurantStore.from(ctx).booking(ctx.match[1]); if (!b || b.telegram_id !== ctx.from?.id || b.status !== "confirmed") return void await ctx.editMessageText("That booking can’t be found.", { reply_markup: back }); await ctx.editMessageText(`Here’s your booking: ${label(b)}. Reference ${b.reference_code}.`, { reply_markup: manageKeys(b) }); });
composer.callbackQuery(/^booking:cancel:([A-Z0-9]+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const b = await RestaurantStore.from(ctx).booking(ctx.match[1]); if (!b || b.telegram_id !== ctx.from?.id || b.status !== "confirmed") return void await ctx.editMessageText("That booking can’t be cancelled.", { reply_markup: back }); await ctx.editMessageText(`Cancel your booking for ${label(b)}?`, { reply_markup: inlineKeyboard([[inlineButton("Cancel booking", `booking:cancel-yes:${b.reference_code}`)], [inlineButton("Keep booking", `booking:open:${b.reference_code}`)]]) }); });
composer.callbackQuery(/^booking:cancel-yes:([A-Z0-9]+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const b = await RestaurantStore.from(ctx).booking(ctx.match[1]); if (!b || b.telegram_id !== ctx.from?.id) return; await RestaurantStore.from(ctx).update(b.reference_code, { status: "cancelled" }); await ctx.editMessageText("Your booking is cancelled. We hope to welcome you another time.", { reply_markup: back }); await sendOwner(ctx, `Booking ${b.reference_code} was cancelled.`); });
composer.callbackQuery(/^booking:reschedule:([A-Z0-9]+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const b = await RestaurantStore.from(ctx).booking(ctx.match[1]); if (!b || b.telegram_id !== ctx.from?.id || b.status !== "confirmed") return; ctx.session.booking = { step: "date", party: b.party_size, code: b.reference_code }; await ctx.editMessageText("Pick a new date for your booking.", { reply_markup: inlineKeyboard([...dates().map((d) => [inlineButton(dateText(d), `booking:date:${d.replaceAll("-", "")}`)]), [inlineButton("Keep booking", `booking:open:${b.reference_code}`)]]) }); });

composer.callbackQuery("admin:home", async (ctx) => { await ctx.answerCallbackQuery(); if (!owner(ctx)) return void await ctx.editMessageText("This dashboard is for the restaurant owner.", { reply_markup: back }); const bookings = await RestaurantStore.from(ctx).upcoming(); const today = now().toISOString().slice(0, 10); const todays = bookings.filter((b) => b.date === today); const lines = bookings.slice(0, 8).map((b) => `${b.date} ${b.time} · ${b.party_size} guests · ${b.reference_code}`); await ctx.editMessageText(`Today has ${todays.reduce((sum, b) => sum + b.party_size, 0)} confirmed guests.\n\n${lines.length ? lines.join("\n") : "No upcoming bookings yet — new reservations will appear here."}`, { reply_markup: inlineKeyboard([...bookings.slice(0, 8).flatMap((b) => [[inlineButton(`Mark ${b.reference_code} no-show`, `admin:noshow:${b.reference_code}`)], [inlineButton(`Cancel ${b.reference_code}`, `admin:cancel:${b.reference_code}`)]]), [inlineButton("Back to menu", "menu:main")]]) }); });
composer.callbackQuery(/^admin:noshow:([A-Z0-9]+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!owner(ctx)) return; const b = await RestaurantStore.from(ctx).update(ctx.match[1], { status: "no_show" }); if (!b) return void await ctx.editMessageText("That booking can’t be found.", { reply_markup: back }); await ctx.editMessageText(`Marked booking ${b.reference_code} as a no-show.`, { reply_markup: back }); await sendOwner(ctx, `Booking ${b.reference_code} was marked as a no-show.`); });
composer.callbackQuery(/^admin:cancel:([A-Z0-9]+)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!owner(ctx)) return; const b = await RestaurantStore.from(ctx).update(ctx.match[1], { status: "cancelled" }); if (!b) return void await ctx.editMessageText("That booking can’t be found.", { reply_markup: back }); await ctx.editMessageText(`Cancelled booking ${b.reference_code}.`, { reply_markup: back }); await sendOwner(ctx, `Booking ${b.reference_code} was cancelled by the owner.`); });

composer.on("message:text", async (ctx, next) => { if (ctx.session.booking?.step !== "phone") return next(); const phone = ctx.message.text.trim(); if (!/^\+?[1-9][\d\s-]{6,19}$/.test(phone) || !ctx.from) return void await ctx.reply("That doesn’t look like a phone number. Send it in international format, like +15551234567."); const flow = ctx.session.booking; const store = RestaurantStore.from(ctx); if (!flow.party || !flow.date || !flow.time) return; const booking = flow.code ? await store.reschedule(flow.code, flow.date, flow.time) : await store.create({ guest_name: ctx.from.first_name, telegram_id: ctx.from.id, date: flow.date, time: flow.time, party_size: flow.party }); if (!booking) return void await ctx.reply("That time was just taken. Tap Book a table to choose another time."); ctx.session.booking = undefined; await ctx.reply(`You’re booked for ${label(booking)}. Your reference is ${booking.reference_code}.`, { reply_markup: manageKeys(booking) }); await scheduleReminder(ctx, booking); await sendOwner(ctx, `${flow.code ? "Rescheduled" : "New"} booking: ${booking.date} at ${booking.time} for ${booking.party_size} guests. Ref ${booking.reference_code}.`); });

export default composer;
