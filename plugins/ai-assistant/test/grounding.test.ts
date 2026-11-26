import { it, expect } from "vite-plus/test";
import type { Context, Member } from "@cicord/sdk";
import { searchKnowledge, sections } from "../src/knowledge.ts";
import { askProvider } from "../src/provider.ts";

it("withholds private sources before model dispatch and drops deleted files", async () => {
  const path = "knowledge/staff.md",
    files = new Map([
      [path, "---\nchannel: staff\n---\n# Rota\nSwap shifts in the staff calendar."],
    ]);
  let access = true;
  const ctx = {
    config: { minRelevance: 0.3, documentBaseURL: "https://docs.example.org" },
    features: { enabled: () => false },
    files: { list: async () => [...files.keys()], read: async (p: string) => files.get(p) },
    index: (name: string) => ({
      search: async () => (name === "knowledge" ? [{ score: 1, meta: { path, section: 0 } }] : []),
    }),
  } as unknown as Context;
  const staff = { canView: () => access } as unknown as Member,
    member = { canView: () => false } as unknown as Member;
  const ask = (user: Member) => searchKnowledge(ctx, "staff rota", user);
  expect((await ask(staff))[0]?.title).toBe("Rota");
  expect(await ask(member)).toEqual([]);
  access = false;
  expect(await ask(staff)).toEqual([]);
  access = true;
  files.clear();
  expect(await ask(staff)).toEqual([]);
});

it("publishes only exact approved citations on a 50-question provider fixture", async () => {
  const faq = [
    ["How do I reset my password?", "Open Account and choose Reset password."],
    ["Where can I report spam?", "Use Report on the message menu."],
    ["How do I enroll as a mentor?", "Submit the mentor application in the portal."],
    ["Where is my ticket history?", "Open My tickets in the support portal."],
    ["How do I mute a channel?", "Select Mute channel from its menu."],
    ["Where is the events calendar?", "Open the Calendar page in the member portal."],
    ["What is the welcome session called?", "The welcome session is called First Steps."],
    ["Where can I read the rules?", "Read the pinned rules in the welcome channel."],
    ["How do I subscribe to announcements?", "Choose the Announcements role during onboarding."],
    ["How do I find my language group?", "Select a language on the Roles page."],
    ["Who can approve an event?", "Event organizers approve proposed events."],
    ["Where do I submit feedback?", "Use the suggestions form on the portal."],
    ["How do I leave a voice room?", "Select Disconnect in the voice panel."],
    ["What are the accessibility hours?", "Accessibility office hours take place on Tuesdays."],
    ["Where is the code of conduct?", "Find the code of conduct under Community documents."],
    ["How do I mark a question resolved?", "Use Mark resolved on the help thread."],
    ["Where are maintenance notices?", "Read the service notices in the status channel."],
    ["How do I disable reminders?", "Turn off reminders in Notification preferences."],
    ["How do I change my display name?", "Edit Display name in your member settings."],
    [
      "What is the volunteer orientation?",
      "Volunteer orientation is the Getting Started workshop.",
    ],
    ["Where are meeting notes?", "Staff publish meeting notes in the archive."],
    ["How do I request a translation?", "Open a translation request in the support portal."],
    ["How do I delete a saved tag?", "Moderators can delete tags in the editor."],
    ["Where can I ask about moderation?", "Send a question using the moderation contact form."],
    ["How do I opt out of the assistant?", "Run the ask optout command and enable the preference."],
  ];
  const unknown = [
    "Who invented the telescope?",
    "What is the share price?",
    "Predict the next match.",
    "Which car is fastest?",
    "Translate this novel.",
    "Solve my tax return.",
    "Who won the election?",
    "What is my bank balance?",
    "Where is the nearest hotel?",
    "Can I buy a flight?",
    "Who created the universe?",
    "Design a bridge.",
    "What are tomorrow’s tides?",
    "Which language is oldest?",
    "Who owns this apartment?",
    "What is the mayor’s number?",
    "Can you print a passport?",
    "Tell me the answer key.",
    "Write a song about cats.",
    "What is the price of silver?",
    "How does photosynthesis work?",
    "Summarize a film.",
    "What is my annual allowance?",
    "Which rocket reached orbit?",
    "Show an unreleased roadmap.",
  ];
  const docs = faq.map(
    ([question, answer], i) =>
      sections(
        "# " + question + "\n" + answer,
        "knowledge/faq-" + i + ".md",
        "https://docs.example.org/",
      )[0]!,
  );
  for (const [n, question] of [...faq.map((v) => v[0]!), ...unknown].entries()) {
    const choice = {
      source: n < faq.length ? n : 0,
      quote: n < faq.length ? faq[n]![1] : "No such statement appears in the supplied documents.",
    };
    const ctx = {
      config: { model: "fixture", maxOutputTokens: 200 },
      secrets: { ref: () => "logical" },
      http: {
        fetch: async () => ({
          status: 200,
          headers: {},
          json: async () => ({ content: [{ type: "text", text: JSON.stringify(choice) }] }),
        }),
      },
    } as unknown as Context;
    const result = await askProvider(ctx, question, docs);
    if (n >= faq.length) expect(result).toBe("unknown");
    else expect(result).toMatchObject({ url: docs[n]!.url, text: faq[n]![1] });
  }
});
