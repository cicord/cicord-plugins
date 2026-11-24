/**
 * Onboarding logic, independent of the route plumbing. The portal contract (response
 * shapes) is mirrored by `@cicord/client`'s `onboarding.ts`; keep both in sync.
 */
import type { Context, Json, Member, PluginConfig, Role } from "@cicord/sdk";

type StepConfig = PluginConfig["steps"][number];

// ───────────────────────────────────────────────────────────── contract (JSON shapes)

type OnboardingOption = {
  role: string;
  label: string;
  emoji: string;
  description: string;
  name: string;
  color: string;
};

type OnboardingStep = {
  id: string;
  title: string;
  description: string;
  multiple: boolean;
  required: boolean;
  options: OnboardingOption[];
  selected: string[];
};

export type OnboardingRole = { key: string; id: string; name: string; color: string };

export type StepsResponse = {
  title: string;
  intro: string;
  steps: OnboardingStep[];
  completedRole: OnboardingRole | null;
  completed: boolean;
  completedAt: string | null;
};

export type CompleteResponse = {
  completed: true;
  completedAt: string;
  roles: OnboardingRole[];
  added: string[];
  removed: string[];
  message: string;
};

/** Stored under `completed:<userId>`. */
export type CompletionRecord = { at: string; answers: { [step: string]: string[] } };

export type Answers = Map<string, string[]>;

/** Same shape as the runtime's validation diagnostics, so `CicordApiError.diagnostics` works. */
export type Problem = { severity: "error"; path: string; message: string };

// ───────────────────────────────────────────────────────────── helpers

export const completionKey = (userId: string): string => `completed:${userId}`;

function toOnboardingRole(role: Role): OnboardingRole {
  return { key: role.key ?? "", id: role.id, name: role.name, color: role.color ?? "" };
}

/** Resolves a role key, or undefined (and a warning) when it no longer exists on Discord. */
function tryRole(ctx: Context, key: string): Role | undefined {
  try {
    return ctx.server.role(key);
  } catch {
    ctx.log.warn("onboarding: configured role not found on the server", { role: key });
    return undefined;
  }
}

/** Steps with unique ids (the schema cannot enforce uniqueness; later duplicates are ignored). */
function configuredSteps(ctx: Context): StepConfig[] {
  const seen = new Set<string>();
  const steps: StepConfig[] = [];
  for (const step of ctx.config.steps ?? []) {
    if (seen.has(step.id)) {
      ctx.log.warn("onboarding: duplicate step id ignored", { step: step.id });
      continue;
    }
    seen.add(step.id);
    steps.push(step);
  }
  return steps;
}

/** Role keys offered by a step that exist on the server. */
function stepRoles(ctx: Context, step: StepConfig): Map<string, Role> {
  const roles = new Map<string, Role>();
  for (const option of step.options) {
    const role = tryRole(ctx, option.role);
    if (role) roles.set(option.role, role);
  }
  return roles;
}

// ───────────────────────────────────────────────────────────── GET /steps

export function resolveSteps(
  ctx: Context,
  member: Member,
  record: CompletionRecord | undefined,
): StepsResponse {
  const steps = configuredSteps(ctx).map((step): OnboardingStep => {
    const options: OnboardingOption[] = [];
    for (const option of step.options) {
      const role = tryRole(ctx, option.role);
      if (!role) continue;
      options.push({
        role: option.role,
        label: option.label || role.name,
        emoji: option.emoji ?? "",
        description: option.description ?? "",
        name: role.name,
        color: role.color ?? "",
      });
    }
    return {
      id: step.id,
      title: step.title,
      description: step.description,
      multiple: step.multiple,
      required: step.required,
      options,
      selected: options.filter((o) => member.hasRole(o.role)).map((o) => o.role),
    };
  });

  const completedRole = ctx.config.completedRole
    ? tryRole(ctx, ctx.config.completedRole)
    : undefined;
  return {
    title: ctx.config.title,
    intro: ctx.config.intro,
    steps,
    completedRole: completedRole ? toOnboardingRole(completedRole) : null,
    completed: record !== undefined,
    completedAt: record?.at ?? null,
  };
}

// ───────────────────────────────────────────────────────────── POST /complete

/**
 * Validates `{answers: {stepId: roleKey[]}}` against the config. A step missing from
 * `answers` means "nothing selected" in that step.
 */
export function parseAnswers(
  ctx: Context,
  body: Json | undefined,
):
  | { ok: true; answers: Answers }
  | { ok: false; status: 400 | 422; message: string; problems: Problem[] } {
  if (!isObject(body) || !isObject(body["answers"])) {
    return {
      ok: false,
      status: 400,
      message: 'expected a JSON body {"answers": {"<step id>": ["<role key>", …]}}',
      problems: [],
    };
  }
  const raw = body["answers"];
  const steps = configuredSteps(ctx);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const problems: Problem[] = [];
  const problem = (path: string, message: string): void => {
    problems.push({ severity: "error", path, message });
  };

  for (const id of Object.keys(raw)) {
    if (!byId.has(id)) problem(`/answers/${id}`, `unknown step "${id}"`);
  }

  const answers: Answers = new Map();
  for (const step of steps) {
    const path = `/answers/${step.id}`;
    const value = raw[step.id];
    let picked: string[] = [];
    if (value !== undefined && value !== null) {
      if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) {
        problem(path, "must be an array of role keys");
        continue;
      }
      picked = [...new Set(value)];
    }
    const offered = new Set(step.options.map((o) => o.role));
    for (const role of picked) {
      if (!offered.has(role)) problem(path, `"${role}" is not an option of step "${step.id}"`);
    }
    if (!step.multiple && picked.length > 1)
      problem(path, `step "${step.id}" accepts a single choice`);
    if (step.required && picked.length === 0) problem(path, `step "${step.id}" is required`);
    answers.set(step.id, picked);
  }

  if (problems.length > 0) {
    return { ok: false, status: 422, message: problems.map((p) => p.message).join("; "), problems };
  }
  return { ok: true, answers };
}

export interface RolePlan {
  add: Role[];
  remove: Role[];
}

/**
 * Role changes for a member. Only roles offered by the config (and `completedRole`) are
 * ever touched: an unselected option is removed, a selected one added.
 */
export function planRoles(ctx: Context, member: Member, answers: Answers): RolePlan {
  const offered = new Map<string, Role>();
  for (const step of configuredSteps(ctx)) {
    for (const [key, role] of stepRoles(ctx, step)) offered.set(key, role);
  }
  const wanted = new Set<string>();
  for (const roles of answers.values()) for (const key of roles) wanted.add(key);

  const completedKey = ctx.config.completedRole;
  const completedRole = completedKey ? tryRole(ctx, completedKey) : undefined;
  if (completedKey && completedRole) {
    offered.set(completedKey, completedRole);
    wanted.add(completedKey);
  }

  const plan: RolePlan = { add: [], remove: [] };
  for (const [key, role] of offered) {
    const has = member.hasRole(key);
    if (wanted.has(key) && !has) plan.add.push(role);
    else if (!wanted.has(key) && has) plan.remove.push(role);
  }
  return plan;
}

/** The member's roles after applying `plan` (member.roles may not refresh in place). */
export function rolesAfter(member: Member, plan: RolePlan): OnboardingRole[] {
  const removed = new Set(plan.remove.map((r) => r.id));
  const result = new Map<string, Role>();
  for (const role of member.roles) if (!removed.has(role.id)) result.set(role.id, role);
  for (const role of plan.add) result.set(role.id, role);
  return [...result.values()].map(toOnboardingRole);
}

export function answersRecord(answers: Answers): CompletionRecord["answers"] {
  return Object.fromEntries(answers);
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
