import type { ArgDef, ArgsDef, CommandDef } from 'citty';

/** Thrown for every caller argv problem; index.ts converts it to INVALID_ARGS (exit 2). */
export class CliArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgsError';
  }
}

export function isCliArgsError(err: unknown): err is CliArgsError {
  return err instanceof CliArgsError;
}

/**
 * citty's ArgDef union widened with the repo-local `multiple` marker and with
 * `alias` (absent from PositionalArgDef) so the spec builder can read both.
 */
export type CliArgDef = ArgDef & { multiple?: boolean; alias?: string | string[] };

/**
 * Parsed leaf args. Contains only declared kebab-case names plus `_`; a key is
 * omitted when the arg is absent and has no default.
 * - string flag: string
 * - `multiple` string flag: string[] with at least one element (never [])
 * - boolean flag: boolean (absent → declared default, else omitted)
 * - positional: string (absent and optional → declared default, else omitted)
 * `_` holds all positional tokens in order (kept for citty `ParsedArgs` shape compatibility).
 */
export type ParsedCommandArgs = { _: string[] } & Record<string, string | string[] | boolean | undefined>;

/** A resolved leaf: `run` is guaranteed present. */
export type LeafCommand = CommandDef<ArgsDef> & { run: NonNullable<CommandDef<ArgsDef>['run']> };

export type ResolvedCliCommand = {
  command: LeafCommand;
  /** Subcommand names from the root, excluding the root, e.g. ['stats', 'tokens']. */
  path: string[];
  /** Tokens after the leaf command name. */
  rawArgs: string[];
  /** The leaf's `args`, already resolved from citty's Resolvable form. */
  argsDef: ArgsDef;
};

type FlagSpec = {
  name: string;
  type: 'string' | 'boolean';
  multiple: boolean;
  required: boolean;
  default: string | boolean | undefined;
};

type PositionalSpec = {
  name: string;
  required: boolean;
  default: string | undefined;
};

type CommandSpec = {
  flags: Map<string, FlagSpec>;
  positionals: PositionalSpec[];
};

function buildCommandSpec(argsDef: ArgsDef, commandPath: string): CommandSpec {
  const flags = new Map<string, FlagSpec>();
  const positionals: PositionalSpec[] = [];

  for (const [name, rawDef] of Object.entries(argsDef)) {
    const def = rawDef as CliArgDef;
    const where = `arg '${name}' of command ${commandPath}`;
    if (name === '_') {
      throw new Error(`Malformed command definition: ${where} uses the reserved name '_'`);
    }
    const type: unknown = def.type;
    if (type !== 'string' && type !== 'boolean' && type !== 'positional') {
      throw new Error(`Malformed command definition: ${where} must declare type 'string', 'boolean' or 'positional'`);
    }
    if (def.alias !== undefined) {
      throw new Error(`Malformed command definition: ${where} declares an alias, which strict parsing does not support`);
    }
    if (def.multiple !== undefined && (type !== 'string' || def.default !== undefined)) {
      throw new Error(`Malformed command definition: ${where} sets 'multiple' on a non-string arg or alongside a default`);
    }

    const required = def.required === true;
    if (type === 'positional') {
      positionals.push({
        name,
        required: def.required !== false && def.default === undefined,
        default: def.default as string | undefined,
      });
      continue;
    }
    flags.set(name, {
      name,
      type,
      multiple: def.multiple === true,
      required,
      default: def.default,
    });
  }

  for (const name of flags.keys()) {
    if (name.startsWith('no-') && flags.has(name.slice(3))) {
      throw new Error(
        `Malformed command definition: command ${commandPath} declares both '${name.slice(3)}' and '${name}'`,
      );
    }
  }

  return { flags, positionals };
}

function supportedFlagsSuffix(spec: CommandSpec, commandPath: string): string {
  if (spec.flags.size === 0) return `(command ${commandPath} accepts no flags)`;
  return `(supported flags: ${[...spec.flags.keys()].map((n) => `--${n}`).join(', ')})`;
}

function unknownFlagError(token: string, spec: CommandSpec, commandPath: string): CliArgsError {
  return new CliArgsError(`unknown flag ${token} for command ${commandPath} ${supportedFlagsSuffix(spec, commandPath)}`);
}

function booleanFormError(name: string, commandPath: string): CliArgsError {
  return new CliArgsError(
    `flag --${name} for command ${commandPath} is a boolean; use --${name}, --no-${name}, --${name}=true or --${name}=false`,
  );
}

/** Token as written, without any `=value` part, so values are never echoed. */
function tokenHead(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

/** Define an own enumerable property; safe for names like `__proto__`. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Strictly parse a leaf's raw tokens against its declared args. Throws
 * CliArgsError for caller problems and a plain Error for malformed defs, which
 * surfaces as FORMAT_ERROR because it is a programmer error, not a caller one.
 */
export function parseCommandArgs(
  rawArgs: readonly string[],
  argsDef: ArgsDef,
  commandPath: string,
): ParsedCommandArgs {
  const spec = buildCommandSpec(argsDef, commandPath);

  const values = new Map<string, string | string[] | boolean>();
  const seen = new Set<string>();
  const positionalTokens: string[] = [];

  const record = (flag: FlagSpec, token: string, value: string | boolean): void => {
    if (seen.has(flag.name) && !flag.multiple) {
      throw new CliArgsError(`flag ${tokenHead(token)} for command ${commandPath} may only be given once`);
    }
    seen.add(flag.name);
    if (typeof value === 'string') {
      if (value === '') {
        throw new CliArgsError(`flag --${flag.name} for command ${commandPath} requires a non-empty value`);
      }
      if (flag.multiple) {
        const existing = values.get(flag.name);
        if (Array.isArray(existing)) existing.push(value);
        else values.set(flag.name, [value]);
        return;
      }
    }
    values.set(flag.name, value);
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i] as string;

    if (token === '--') {
      for (let j = i + 1; j < rawArgs.length; j++) positionalTokens.push(rawArgs[j] as string);
      break;
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

      const declared = spec.flags.get(name);
      if (declared) {
        if (declared.type === 'string') {
          let value: string;
          if (inlineValue !== undefined) {
            value = inlineValue;
          } else {
            const next = rawArgs[i + 1];
            if (next === undefined || next.startsWith('--')) {
              throw new CliArgsError(
                `flag --${name} for command ${commandPath} requires a value; use --${name}=<value> if the value starts with --`,
              );
            }
            value = next;
            i++;
          }
          record(declared, token, value);
        } else if (inlineValue !== undefined) {
          if (inlineValue !== 'true' && inlineValue !== 'false') throw booleanFormError(name, commandPath);
          record(declared, token, inlineValue === 'true');
        } else {
          const next = rawArgs[i + 1];
          if (next === 'true' || next === 'false') throw booleanFormError(name, commandPath);
          record(declared, token, true);
        }
        continue;
      }

      if (name.startsWith('no-')) {
        const base = spec.flags.get(name.slice(3));
        if (base && base.type === 'boolean') {
          if (inlineValue !== undefined) throw booleanFormError(base.name, commandPath);
          const next = rawArgs[i + 1];
          if (next === 'true' || next === 'false') throw booleanFormError(base.name, commandPath);
          record(base, token, false);
          continue;
        }
      }

      throw unknownFlagError(`--${name}`, spec, commandPath);
    }

    if (token.startsWith('-')) {
      throw unknownFlagError(tokenHead(token), spec, commandPath);
    }

    positionalTokens.push(token);
  }

  if (positionalTokens.length > spec.positionals.length) {
    const extra = positionalTokens[spec.positionals.length] as string;
    const expected =
      spec.positionals.length === 0
        ? `command ${commandPath} takes no positional arguments`
        : `expected: ${spec.positionals.map((p) => `<${p.name}>`).join(' ')}`;
    throw new CliArgsError(`unexpected argument '${extra}' for command ${commandPath} (${expected})`);
  }

  const out: Record<string, unknown> = { _: positionalTokens };

  spec.positionals.forEach((positional, index) => {
    const token = positionalTokens[index];
    if (token !== undefined) {
      setOwn(out, positional.name, token);
    } else if (positional.required) {
      throw new CliArgsError(`missing required argument <${positional.name}> for command ${commandPath}`);
    } else if (positional.default !== undefined) {
      setOwn(out, positional.name, positional.default);
    }
  });

  for (const flag of spec.flags.values()) {
    const value = values.get(flag.name);
    if (value !== undefined) {
      setOwn(out, flag.name, value);
    } else if (flag.default !== undefined) {
      setOwn(out, flag.name, flag.default);
    } else if (flag.required) {
      throw new CliArgsError(`missing required flag --${flag.name} for command ${commandPath}`);
    }
  }

  return out as ParsedCommandArgs;
}

/** Mirror of citty's Resolvable handling: a value, a promise, or a (possibly async) thunk. */
async function resolveValue<T>(input: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
  return typeof input === 'function' ? await (input as () => T | Promise<T>)() : await input;
}

function hasOwnKeys(value: object | null | undefined): value is Record<string, CommandDef<ArgsDef>> {
  return value != null && Object.keys(value).length > 0;
}

/**
 * Walk `root.subCommands` along argv. Throws CliArgsError for caller dispatch
 * problems and a plain Error (surfacing as FORMAT_ERROR) for malformed command
 * definitions.
 */
export async function resolveCliCommand(
  root: CommandDef<ArgsDef>,
  argv: readonly string[],
): Promise<ResolvedCliCommand> {
  const rootMeta = await resolveValue(root.meta);
  const rootName = rootMeta?.name;
  if (typeof rootName !== 'string' || rootName === '') {
    throw new Error('Malformed command definition: root command must declare meta.name');
  }

  let current: CommandDef<ArgsDef> = root;
  const path: string[] = [];
  let scope = rootName;
  let index = 0;

  for (;;) {
    const subCommands = current.subCommands ? await resolveValue(current.subCommands) : undefined;

    if (!hasOwnKeys(subCommands)) {
      if (typeof current.run !== 'function') {
        throw new Error(`Malformed command definition: command ${scope} has no subcommands and no run function`);
      }
      if (current.setup !== undefined || current.cleanup !== undefined) {
        throw new Error(
          `Malformed command definition: command ${scope} defines setup/cleanup, which strict dispatch does not run`,
        );
      }
      const argsDef = current.args ? await resolveValue(current.args) : undefined;
      return {
        command: current as LeafCommand,
        path,
        rawArgs: argv.slice(index),
        argsDef: argsDef ?? {},
      };
    }

    if (
      current.args !== undefined ||
      current.run !== undefined ||
      current.setup !== undefined ||
      current.cleanup !== undefined
    ) {
      throw new Error(
        `Malformed command definition: command group ${scope} must not declare args, run, setup or cleanup`,
      );
    }

    const available = `available subcommands: ${Object.keys(subCommands).join(', ')}`;
    const token = argv[index];
    if (token === undefined) {
      throw new CliArgsError(`missing subcommand for command ${scope} (${available})`);
    }
    if (token.startsWith('-')) {
      throw new CliArgsError(
        `unknown flag ${tokenHead(token)} for command ${scope}; flags must follow the subcommand name (${available})`,
      );
    }
    if (!Object.hasOwn(subCommands, token)) {
      throw new CliArgsError(`unknown subcommand '${token}' for command ${scope} (${available})`);
    }

    const next = await resolveValue(subCommands[token] as CommandDef<ArgsDef> | null | undefined);
    path.push(token);
    scope = path.join(' ');
    if (next == null || typeof next !== 'object') {
      throw new Error(`Malformed command definition: command ${scope} resolved to no definition`);
    }
    current = next;
    index++;
  }
}
