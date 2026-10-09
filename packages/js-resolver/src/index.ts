import {
  type AnyNode,
  type ArrayExpression,
  type BlockStatement,
  type CallExpression,
  type IfStatement,
  type ObjectExpression,
  type Program,
  parse,
} from "acorn";

// Redirect code is small. A bigger script is an application bundle, and acorn's syntax tree
// takes many times the memory of the text, so big scripts are skipped and the total is capped.
const MAX_SCRIPT_LENGTH = 64 * 1024;
const MAX_TOTAL_LENGTH = 256 * 1024;
// Work limits for one page, so that a hostile script cannot make the analysis slow.
const MAX_STEPS = 20_000;
const MAX_DEPTH = 40;
/** At most this many strings given to a timer are read as code. */
const MAX_SNIPPETS = 20;
// A computed string longer than this is not a URL anyone would follow. It caps timer code too.
const MAX_VALUE_LENGTH = 16 * 1024;
/**
 * A timer that waits longer than this is a session timeout ("log out after 15 minutes"), not a
 * redirect page: the same 60 seconds html-resolver allows a meta refresh.
 */
const MAX_TIMER_DELAY_MS = 60_000;

// Calls that run the function they get after the page has loaded, or after a delay.
const TIMERS = new Set(["setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask"]);
const LOAD_EVENTS = new Set(["load", "DOMContentLoaded", "pageshow"]);
const WINDOW_NAMES = new Set(["window", "self", "top", "parent", "frames", "globalThis"]);
// Methods that change the array, URLSearchParams or map they are called on.
const CHANGING_METHODS = new Set([
  "set",
  "append",
  "delete",
  "sort",
  "reverse",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "fill",
  "copyWithin",
]);

/** The answer for an expression that cannot be worked out without running the page. */
const UNKNOWN = Symbol("unknown");
/** Stand-ins for `window` (also `self`, `top`...), `document` and the page's own `location`. */
const WINDOW = Symbol("window");
const DOCUMENT = Symbol("document");
const LOCATION = Symbol("location");
type Value = string | number | boolean | null | object | symbol;

/** Code that runs for some visitors only: a test, loop or catch decides whether it runs. */
const SOMETIMES = Symbol("sometimes");
/** The function a piece of code is part of, null for the top of a script, or SOMETIMES. */
type Owner = AnyNode | null | typeof SOMETIMES;

/** An object or array literal in the code, read only as far as a property is asked for. */
class CodeLiteral {
  readonly node: ObjectExpression | ArrayExpression;
  constructor(node: ObjectExpression | ArrayExpression) {
    this.node = node;
  }
}

/** A place that sends the browser elsewhere, and the expression for where. */
interface Sink {
  at: AnyNode;
  target: AnyNode | undefined;
  /** window.open(url, name) leaves the page only when name is "_self", "_top" or "_parent". */
  open?: { windowName: AnyNode | undefined };
}

export type JsFinding =
  /** The scripts send the visitor to `url` once the page loads (absolute, not yet checked). */
  | { kind: "redirect"; url: string }
  /** They certainly leave the page by themselves, but where to could not be worked out. */
  | { kind: "unknown" }
  | { kind: "none" };

/**
 * Reads a page's scripts without running them and finds a redirect they make by themselves:
 * `location = url`, `location.href = url`, `location.replace(url)`, `location.assign(url)` or
 * `window.open(url, "_self")`, at the top level or in code the page runs on its own (a timer of
 * up to a minute, an onload handler, a function that is called right away). Code that only runs
 * after a click, or in some browsers only (behind a test, or after `if (...) return;`), never
 * counts, unless the visitor is sent elsewhere whichever way the test goes. The URL is worked out
 * from string literals, +, variables, decodeURIComponent/unescape, atob, JSON, the page's own
 * query string (URLSearchParams) and a few string methods. Relative URLs use `base`.
 */
export function findJsTarget(scripts: string[], page: URL, base: URL = page): JsFinding {
  // Most pages never mention location: no need to parse anything.
  if (!scripts.some((script) => /location|open\s*\(/.test(script))) return { kind: "none" };
  try {
    return analyse(scripts, page, base);
  } catch (error) {
    // Code nested so deeply that following it overflows the stack was not understood.
    if (error instanceof RangeError) return { kind: "unknown" };
    throw error;
  }
}

function analyse(scripts: string[], page: URL, base: URL): JsFinding {
  const code = new PageScripts(page);
  let total = 0;
  for (const script of scripts) {
    if (script.length > MAX_SCRIPT_LENGTH || total + script.length > MAX_TOTAL_LENGTH) continue;
    total += script.length;
    code.add(script);
  }
  code.addTimerCode();

  const targets = new Set<string>();
  let unknown = false;
  for (const sink of code.sinks) {
    if (!code.redirectsOnLoad(sink.at)) continue;
    if (sink.open) {
      const name = sink.open.windowName && code.evaluate(sink.open.windowName);
      if (name !== "_self" && name !== "_top" && name !== "_parent") continue; // a new window
    }
    const text = sink.target === undefined ? null : code.asText(code.evaluate(sink.target));
    const url = text === null ? null : URL.parse(text, base.href);
    if (url === null) {
      unknown = true;
      continue;
    }
    // Sending the page to itself is a reload, or a frame breaking out of its frameset.
    if (withoutFragment(url) !== withoutFragment(page)) targets.add(url.href);
  }
  const [only] = targets;
  if (only !== undefined && targets.size === 1 && !unknown) return { kind: "redirect", url: only };
  return targets.size > 0 || unknown ? { kind: "unknown" } : { kind: "none" };
}

/** Everything the analysis knows about a page's scripts, built by reading their syntax trees. */
class PageScripts {
  readonly page: URL;
  readonly sinks: Sink[] = [];
  readonly #parents = new Map<AnyNode, AnyNode>();
  /** Code given to setTimeout as a string: its tree, and the call that runs it. */
  readonly #triggers = new Map<AnyNode, CallExpression>();
  /** Every value given to each name. Only a name with exactly one can be worked out. */
  readonly #definitions = new Map<string, (AnyNode | null)[]>();
  readonly #functions = new Map<string, AnyNode[]>();
  readonly #references = new Map<string, AnyNode[]>();
  readonly #allFunctions: AnyNode[] = [];
  readonly #timerCalls: { call: CallExpression; code: AnyNode }[] = [];
  /** Statements with a return or throw inside, other than in a function of its own. */
  readonly #exits = new Set<AnyNode>();
  // Answers worked out from the code read so far, kept because the same questions come up again.
  readonly #stops = new Map<AnyNode, number>();
  readonly #after = new Map<AnyNode, boolean>();
  readonly #eitherWay = new Map<AnyNode, boolean>();
  readonly #counters = new Map<string, boolean>();
  readonly #timerFunctions = new Map<AnyNode, boolean>();
  /** The functions the page runs by itself, worked out once every script has been read. */
  #running: Set<AnyNode> | undefined;
  #steps = 0;

  constructor(page: URL) {
    this.page = page;
  }

  /** Parses one script (skipped when acorn cannot read it) and records what matters in it. */
  add(source: string, trigger?: CallExpression): void {
    const options = { ecmaVersion: "latest", allowReturnOutsideFunction: true } as const;
    let program: AnyNode;
    try {
      program = parse(source, { ...options, sourceType: "script" });
    } catch {
      try {
        program = parse(source, { ...options, sourceType: "module" });
      } catch {
        return; // not JavaScript acorn can read (or nested too deep): it cannot be analysed
      }
    }
    if (trigger) this.#triggers.set(program, trigger);
    for (const [node, parent] of walk(program)) {
      if (parent) this.#parents.set(node, parent);
      this.#record(node);
    }
    // New code can give names new values, which changes the answers worked out so far.
    for (const answers of [
      this.#stops,
      this.#after,
      this.#eitherWay,
      this.#counters,
      this.#timerFunctions,
    ]) {
      answers.clear();
    }
    this.#running = undefined;
  }

  /**
   * setTimeout("location.href = '...'", 1000): the string is code, so it is read as a script.
   * Such code can start timers of its own; the loop sees those too, up to MAX_SNIPPETS in all.
   */
  addTimerCode(): void {
    let snippets = 0;
    for (const timer of this.#timerCalls) {
      if (this.#waitsLong(timer.call)) continue;
      const code = this.evaluate(timer.code);
      if (typeof code !== "string") continue;
      if (snippets === MAX_SNIPPETS) return;
      snippets += 1;
      this.add(code, timer.call);
    }
  }

  #record(node: AnyNode): void {
    switch (node.type) {
      case "VariableDeclarator":
        if (node.id.type === "Identifier") {
          if (node.init) this.#define(node.id.name, node.init);
          if (node.init && isFunction(node.init)) {
            this.#add(this.#functions, node.id.name, node.init);
          }
        } else {
          for (const name of patternNames(node.id)) this.#define(name, null);
        }
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        this.#allFunctions.push(node);
        if (node.type === "FunctionDeclaration" && node.id) {
          this.#define(node.id.name, null);
          this.#add(this.#functions, node.id.name, node);
        }
        for (const name of node.params.flatMap(patternNames)) this.#define(name, null);
        break;
      case "AssignmentExpression":
        if (node.left.type === "Identifier") {
          // `n -= 1` is kept as it is, so that a counter can be recognised (see #isCounter).
          this.#define(node.left.name, node.operator === "=" ? node.right : node);
          if (node.operator === "=" && isFunction(node.right)) {
            this.#add(this.#functions, node.left.name, node.right);
          }
        } else if (node.left.type === "MemberExpression") {
          this.#changed(node.left);
        } else {
          for (const name of patternNames(node.left)) this.#define(name, null);
        }
        if (node.operator === "=" && (isLocation(node.left) || isLocationHref(node.left))) {
          this.sinks.push({ at: node, target: node.right });
        }
        break;
      case "UpdateExpression":
        if (node.argument.type === "Identifier") this.#define(node.argument.name, node);
        else this.#changed(node.argument);
        break;
      case "UnaryExpression":
        if (node.operator === "delete") this.#changed(node.argument);
        break;
      case "CatchClause":
        if (node.param) for (const name of patternNames(node.param)) this.#define(name, null);
        break;
      case "ForInStatement":
      case "ForOfStatement":
        if (node.left.type === "VariableDeclaration") {
          for (const name of node.left.declarations.flatMap((d) => patternNames(d.id))) {
            this.#define(name, null);
          }
        } else {
          for (const name of patternNames(node.left)) this.#define(name, null);
        }
        break;
      case "ClassDeclaration":
        if (node.id) this.#define(node.id.name, null);
        break;
      case "ReturnStatement":
      case "ThrowStatement":
        // The statements around it, up to its function, may end early (see #leaves).
        for (let at = this.#parents.get(node); at && !isFunction(at); at = this.#parents.get(at)) {
          if (this.#exits.has(at)) break; // and so do the ones around that one
          this.#exits.add(at);
        }
        break;
      case "CallExpression": {
        const callee = node.callee;
        if (isLocationCall(node)) this.sinks.push({ at: node, target: node.arguments[0] });
        if (isWindowOpen(node)) {
          const windowName = node.arguments[1];
          this.sinks.push({ at: node, target: node.arguments[0], open: { windowName } });
        }
        if (
          callee.type === "MemberExpression" &&
          CHANGING_METHODS.has(propertyName(callee) ?? "")
        ) {
          this.#changed(callee);
        }
        const first = node.arguments[0];
        if (isTimer(node) && first && !isFunction(first)) {
          this.#timerCalls.push({ call: node, code: first });
        }
        break;
      }
      case "Identifier":
        this.#add(this.#references, node.name, node);
        break;
    }
  }

  #define(name: string, value: AnyNode | null): void {
    this.#add(this.#definitions, name, value);
  }

  /** obj.url = ..., list[0] = ..., u.searchParams.set(...): `obj`, `list` or `u` has changed. */
  #changed(target: AnyNode): void {
    let root = target;
    while (root.type === "MemberExpression") root = root.object;
    if (root !== target && root.type === "Identifier") this.#define(root.name, null);
  }

  #add<K, T>(map: Map<K, T[]>, key: K, value: T): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }

  #list<K, T>(map: Map<K, T[]>, key: K): T[] {
    return map.get(key) ?? [];
  }

  /** The node around `node`, for a node that has one: anything but the top of a script. */
  #parent(node: AnyNode): AnyNode {
    return this.#parents.get(node) as AnyNode;
  }

  /**
   * Whether the redirect at `node` happens once the page has loaded: no test, loop or catch
   * decides whether it runs, and the page itself runs every function around it. A redirect
   * behind a test still counts when the visitor is sent somewhere whichever way the test goes:
   * then each way out is one of the page's destinations. Asked once every script is added.
   */
  redirectsOnLoad(node: AnyNode): boolean {
    this.#running ??= this.#findRunning();
    return this.#runs(node, true);
  }

  /**
   * Whether the code at `node` runs for every visitor, given the functions known to run so far
   * (none while they are still worked out). See redirectsOnLoad for `redirect`.
   */
  #runs(node: AnyNode, redirect = false): boolean {
    const owner = this.#owner(node, redirect);
    return owner === null || (owner !== SOMETIMES && this.#running?.has(owner) === true);
  }

  /** The function the code at `node` is part of (see Owner). */
  #owner(node: AnyNode, redirect = false): Owner {
    // Code given to a timer as a string counts as sitting inside the call that starts the timer.
    const above = (child: AnyNode) => this.#parents.get(child) ?? this.#triggers.get(child);
    let child = node;
    for (let parent = above(child); parent; parent = above(child)) {
      if (isFunction(parent)) return parent;
      if (!this.#reaches(parent, child, redirect)) return SOMETIMES;
      child = parent;
    }
    return null;
  }

  /** Whether everyone who runs `parent` also runs `child`, or has been sent elsewhere before. */
  #reaches(parent: AnyNode, child: AnyNode, redirect: boolean): boolean {
    switch (parent.type) {
      case "Program":
      case "BlockStatement":
        // Code after `if (!isMobile) return;` runs for some visitors only.
        return child.start <= this.#stopAt(parent);
      case "IfStatement":
        if (child === parent.test || this.#isCountdown(parent)) return true;
        return redirect && this.#leavesEitherWay(parent);
      case "ConditionalExpression":
        return child === parent.test || (redirect && isLeaving(parent));
      case "LogicalExpression":
        return child === parent.left;
      case "AssignmentExpression":
        // a ||= b, a &&= b and a ??= b run b only sometimes.
        return child === parent.left || !["||=", "&&=", "??="].includes(parent.operator);
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "SwitchCase":
      case "CatchClause":
        return false;
      default:
        return true;
    }
  }

  /** Where the code of a block stops running for everyone: at the first statement that may end it. */
  #stopAt(block: Program | BlockStatement): number {
    return remember(this.#stops, block, () => {
      const stop = (block.body as AnyNode[]).find((statement) => !this.#leaves(statement, true));
      return stop?.start ?? Number.POSITIVE_INFINITY;
    });
  }

  /**
   * Whether every way through `statement` leaves the page or, when `rest` is true, goes on to the
   * code after it. A return, throw, break or continue ends the code early.
   */
  #leaves(statement: AnyNode, rest: boolean): boolean {
    switch (statement.type) {
      case "ExpressionStatement":
        return rest || isLeaving(statement.expression);
      case "BlockStatement":
        return statement.body.reduceRight<boolean>(
          (after, inner) => this.#leaves(inner, after),
          rest,
        );
      case "IfStatement": {
        if (this.#isCountdown(statement)) return rest; // its test changes in the end
        const otherwise = statement.alternate ? this.#leaves(statement.alternate, rest) : rest;
        return otherwise && this.#leaves(statement.consequent, rest);
      }
      case "ReturnStatement":
      case "ThrowStatement":
      case "BreakStatement":
      case "ContinueStatement":
        return false;
      default:
        // Loops, switch and try are not followed inside, except that a return or throw in them
        // may end the code early.
        return rest && !this.#exits.has(statement);
    }
  }

  /** Whether the rest of the block after `statement` leaves the page; the end of it does not. */
  #leavesAfter(statement: AnyNode): boolean {
    const parent = this.#parent(statement);
    if (parent.type !== "Program" && parent.type !== "BlockStatement") return false;
    if (!this.#after.has(statement)) {
      (parent.body as AnyNode[]).reduceRight((after, inner) => {
        this.#after.set(inner, after);
        return this.#leaves(inner, after);
      }, false);
    }
    return this.#after.get(statement) as boolean;
  }

  /** if (iPhone) location.href = A; else location.href = B: everyone is sent somewhere. */
  #leavesEitherWay(statement: IfStatement): boolean {
    return remember(this.#eitherWay, statement, () =>
      this.#leaves(statement, this.#leavesAfter(statement)),
    );
  }

  /**
   * if (--seconds <= 0) inside a function a timer runs: the classic "you will be sent on in 5
   * seconds" page. The test reads nothing but counters (see #isCounter), so it changes in the end.
   */
  #isCountdown(statement: IfStatement): boolean {
    if (!this.#isCountdownTest(statement.test)) return false;
    let fn = this.#parents.get(statement);
    while (fn && !isFunction(fn)) fn = this.#parents.get(fn);
    // At the top of a script the test is checked only once.
    return fn !== undefined && this.#isTimerFunction(fn);
  }

  /** setInterval(function () { ... }, 1000), or function tick() { ... } and setInterval(tick). */
  #isTimerFunction(fn: AnyNode): boolean {
    return remember(this.#timerFunctions, fn, () => {
      const parent = this.#parent(fn);
      if (isTimerArgument(fn, parent)) return true;
      const name = functionName(fn, parent);
      return (
        name !== undefined &&
        this.#isOnlyFunction(name) &&
        this.#list(this.#references, name).some((reference) =>
          isTimerArgument(reference, this.#parent(reference)),
        )
      );
    });
  }

  /** A test made only of counters, numbers and arithmetic: `--n <= 0`, `count === 0`. */
  #isCountdownTest(test: AnyNode): boolean {
    let counters = 0;
    for (const [node] of walk(test)) {
      switch (node.type) {
        case "Identifier":
          if (!this.#isCounter(node.name)) return false;
          counters += 1;
          break;
        case "Literal":
          if (typeof node.value !== "number" && typeof node.value !== "boolean") return false;
          break;
        case "UpdateExpression":
        case "LogicalExpression":
          break;
        case "BinaryExpression":
          if (node.operator === "in" || node.operator === "instanceof") return false;
          break;
        case "UnaryExpression":
          if (node.operator === "typeof" || node.operator === "delete") return false;
          break;
        case "AssignmentExpression":
          if (node.left.type !== "Identifier") return false;
          break;
        default:
          return false;
      }
    }
    return counters > 0;
  }

  /** `var n = 5`, changed only by `n--`, `n -= 1` or `n = n - 1`: a counter the page counts. */
  #isCounter(name: string): boolean {
    return remember(this.#counters, name, () => {
      const definitions = this.#list(this.#definitions, name);
      const starts = definitions.filter(
        (value) => value?.type === "Literal" && typeof value.value === "number",
      );
      return (
        starts.length === 1 &&
        definitions.length > 1 &&
        definitions.every((value) => starts.includes(value) || isCountingStep(value, name))
      );
    });
  }

  /**
   * The functions the page runs by itself. Starting from the top of the scripts, a function runs
   * when code that runs calls it, starts it as a timer or a load handler, or calls it right away.
   * Worked out in one pass, so a function that only calls itself never counts.
   */
  #findRunning(): Set<AnyNode> {
    // For the code of each function (null: the top of the scripts), the functions it runs.
    const runs = new Map<AnyNode | null, AnyNode[]>();
    for (const fn of this.#allFunctions) {
      for (const runner of this.#runners(fn)) {
        const owner = this.#owner(runner);
        if (owner !== SOMETIMES) this.#add(runs, owner, fn);
      }
    }
    const running = new Set<AnyNode>();
    const queue: (AnyNode | null)[] = [null];
    for (const owner of queue) {
      for (const fn of this.#list(runs, owner)) {
        if (running.has(fn)) continue;
        running.add(fn);
        queue.push(fn);
      }
    }
    return running;
  }

  /** The calls and assignments that run `fn` if they run themselves. */
  *#runners(fn: AnyNode): Generator<AnyNode> {
    const parent = this.#parent(fn);
    // (function () { ... })() and !function () { ... }()
    if (parent.type === "CallExpression" && parent.callee === fn) yield parent;
    // (function () { ... }).call(this) and .apply(this)
    if (parent.type === "MemberExpression" && parent.object === fn) {
      const call = this.#parent(parent);
      const method = propertyName(parent);
      if (method === "call" || method === "apply") {
        if (call.type === "CallExpression" && call.callee === parent) yield call;
      }
    }
    const handler = this.#handlerOf(fn);
    if (handler) yield handler;
    // A named function runs where it is called, or handed over, by its name.
    const name = functionName(fn, parent);
    if (name === undefined || !this.#isOnlyFunction(name)) return;
    for (const reference of this.#list(this.#references, name)) {
      const at = this.#parent(reference);
      if (at.type === "CallExpression" && at.callee === reference) yield at;
      const byName = this.#handlerOf(reference);
      if (byName) yield byName;
    }
  }

  /** The call or assignment that gives `node` to a timer or a load handler, if there is one. */
  #handlerOf(node: AnyNode): AnyNode | undefined {
    const parent = this.#parent(node);
    if (parent.type === "CallExpression")
      return this.#runsHandler(parent, node) ? parent : undefined;
    const onload =
      parent.type === "AssignmentExpression" &&
      parent.right === node &&
      isOnloadProperty(parent.left);
    return onload ? parent : undefined;
  }

  /** The call runs `node`, one of its arguments, once the page has loaded or after a short wait. */
  #runsHandler(call: CallExpression, node: AnyNode): boolean {
    const [first, second] = call.arguments;
    const name = calleeName(call);
    if (name !== undefined && TIMERS.has(name)) return node === first && !this.#waitsLong(call);
    if (name === "addEventListener" || name === "on") {
      if (node !== second) return false;
      // There is an argument 1, so there is an argument 0: the name of the event.
      const event = this.evaluate(first as AnyNode);
      return typeof event === "string" && LOAD_EVENTS.has(event);
    }
    if (node !== first) return false;
    // jQuery: $(fn), jQuery(fn), $(document).ready(fn), $(window).load(fn)
    if (name === "$" || name === "jQuery") return call.callee.type === "Identifier";
    return name === "ready" || name === "load";
  }

  /** setTimeout(go, 15 * 60 * 1000) waits longer than MAX_TIMER_DELAY_MS. */
  #waitsLong(call: CallExpression): boolean {
    const [, delay] = call.arguments;
    const ms = delay === undefined ? 0 : this.evaluate(delay);
    return typeof ms === "number" && ms > MAX_TIMER_DELAY_MS;
  }

  /** The name stands for one function and nothing else, so using the name means that function. */
  #isOnlyFunction(name: string): boolean {
    return (
      this.#list(this.#functions, name).length === 1 &&
      this.#list(this.#definitions, name).length === 1
    );
  }

  /** The value of an expression, or UNKNOWN when it cannot be worked out without running it. */
  evaluate(node: AnyNode, depth = 0): Value {
    this.#steps += 1;
    if (this.#steps > MAX_STEPS || depth > MAX_DEPTH) return UNKNOWN;
    const value = this.#evaluate(node, depth + 1);
    if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) return UNKNOWN;
    if (Array.isArray(value) && value.length > MAX_VALUE_LENGTH) return UNKNOWN;
    return value;
  }

  #evaluate(node: AnyNode, depth: number): Value {
    switch (node.type) {
      case "Literal":
        return node.regex || typeof node.value === "bigint" ? UNKNOWN : (node.value ?? null);
      case "TemplateLiteral": {
        let text = "";
        for (const [index, quasi] of node.quasis.entries()) {
          // Without a tag in front, a bad escape is a syntax error, so `cooked` is always text.
          text += quasi.value.cooked as string;
          const expression = node.expressions[index];
          if (expression === undefined) continue; // the last piece of text
          const part = this.asText(this.evaluate(expression, depth));
          if (part === null || text.length + part.length > MAX_VALUE_LENGTH) return UNKNOWN;
          text += part;
        }
        return text;
      }
      case "BinaryExpression": {
        if (node.operator !== "+" && node.operator !== "*") return UNKNOWN;
        const left = this.evaluate(node.left, depth);
        const right = this.evaluate(node.right, depth);
        if (typeof left === "number" && typeof right === "number") {
          return node.operator === "+" ? left + right : left * right;
        }
        if (node.operator === "*") return UNKNOWN; // only numbers are multiplied here
        const a = this.asText(left);
        const b = this.asText(right);
        return a === null || b === null ? UNKNOWN : a + b;
      }
      case "ThisExpression":
        return WINDOW;
      case "Identifier":
        return this.#evaluateName(node.name, depth);
      case "MemberExpression": {
        const object = this.evaluate(node.object, depth);
        const key = node.computed ? this.evaluate(node.property, depth) : propertyName(node);
        return typeof key === "string" || typeof key === "number"
          ? this.#member(object, String(key), depth)
          : UNKNOWN;
      }
      case "CallExpression":
        return this.#call(node, depth);
      case "NewExpression": {
        const name = node.callee.type === "Identifier" ? node.callee.name : undefined;
        const [first, second] = node.arguments.map((argument) => this.evaluate(argument, depth));
        const input = first === undefined ? "" : this.asText(first);
        if (input === null) return UNKNOWN;
        if (name === "URLSearchParams") return new URLSearchParams(input);
        const baseText = second === undefined ? undefined : this.asText(second);
        if (name !== "URL" || baseText === null) return UNKNOWN;
        return URL.parse(input, baseText) ?? UNKNOWN;
      }
      case "LogicalExpression": {
        const left = this.evaluate(node.left, depth);
        if (left === UNKNOWN) return UNKNOWN;
        if (node.operator === "??") return left === null ? this.evaluate(node.right, depth) : left;
        const truthy = Boolean(left);
        if (node.operator === "||") return truthy ? left : this.evaluate(node.right, depth);
        return truthy ? this.evaluate(node.right, depth) : left;
      }
      case "ConditionalExpression": {
        // The test may depend on the browser, so only two equal answers are certain.
        const yes = this.evaluate(node.consequent, depth);
        return yes === this.evaluate(node.alternate, depth) ? yes : UNKNOWN;
      }
      case "SequenceExpression": {
        let value: Value = UNKNOWN; // (a, b) is worth its last part
        for (const expression of node.expressions) value = this.evaluate(expression, depth);
        return value;
      }
      case "AssignmentExpression":
        return node.operator === "=" ? this.evaluate(node.right, depth) : UNKNOWN;
      case "ChainExpression":
        return this.evaluate(node.expression, depth);
      case "ObjectExpression":
      case "ArrayExpression":
        return new CodeLiteral(node);
      default:
        return UNKNOWN;
    }
  }

  #evaluateName(name: string, depth: number): Value {
    if (name === "location") return LOCATION;
    if (name === "document") return DOCUMENT;
    if (WINDOW_NAMES.has(name)) return WINDOW;
    const definitions = this.#list(this.#definitions, name);
    const [only] = definitions;
    // A value given for some visitors only, or by code that may never run, is not certain.
    return definitions.length === 1 && only && this.#runs(only)
      ? this.evaluate(only, depth)
      : UNKNOWN;
  }

  #member(object: Value, key: string, depth: number): Value {
    if (object === WINDOW) {
      if (key === "location") return LOCATION;
      if (key === "document") return DOCUMENT;
      return WINDOW_NAMES.has(key) ? WINDOW : UNKNOWN;
    }
    if (object === DOCUMENT) {
      if (key === "location") return LOCATION;
      return key === "URL" || key === "documentURI" ? this.page.href : UNKNOWN;
    }
    if (object === LOCATION) return this.#urlPart(this.page, key);
    if (object instanceof URL) {
      return key === "searchParams" ? object.searchParams : this.#urlPart(object, key);
    }
    if (typeof object === "string") {
      if (key === "length") return object.length;
      return /^\d+$/.test(key) ? (object[Number(key)] ?? UNKNOWN) : UNKNOWN;
    }
    if (object instanceof CodeLiteral) return this.#literalMember(object.node, key, depth);
    if (Array.isArray(object))
      return /^\d+$/.test(key) ? (object[Number(key)] ?? UNKNOWN) : UNKNOWN;
    // A plain object from JSON.parse.
    if (typeof object === "object" && object !== null && Object.hasOwn(object, key)) {
      return (object as Record<string, Value>)[key] ?? null;
    }
    return UNKNOWN;
  }

  #urlPart(url: URL, key: string): Value {
    switch (key) {
      case "href":
      case "search":
      case "hash":
      case "pathname":
      case "host":
      case "hostname":
      case "origin":
      case "protocol":
      case "port":
        return url[key];
      default:
        return UNKNOWN;
    }
  }

  #literalMember(node: ObjectExpression | ArrayExpression, key: string, depth: number): Value {
    if (node.type === "ArrayExpression") {
      const element = /^\d+$/.test(key) ? node.elements[Number(key)] : undefined;
      return element && element.type !== "SpreadElement" ? this.evaluate(element, depth) : UNKNOWN;
    }
    let found: Value = UNKNOWN;
    for (const property of node.properties) {
      // A spread could replace anything, so the answer is no longer certain.
      if (property.type === "SpreadElement") return UNKNOWN;
      // { url: ... } names the key; { "url": ... }, { 2: ... } and { [k]: ... } hold a value.
      const name =
        !property.computed && property.key.type === "Identifier"
          ? property.key.name
          : this.evaluate(property.key, depth);
      if (name === UNKNOWN) return UNKNOWN;
      if (String(name) === key && property.kind === "init") {
        found = this.evaluate(property.value, depth); // the last one wins, as in JavaScript
      }
    }
    return found;
  }

  #call(node: CallExpression, depth: number): Value {
    const args = node.arguments.map((argument) =>
      argument.type === "SpreadElement" ? UNKNOWN : this.evaluate(argument, depth),
    );
    const callee = node.callee;
    const name = calleeName(node);
    const object =
      callee.type === "MemberExpression" ? this.evaluate(callee.object, depth) : UNKNOWN;
    // Global functions, also when called as window.atob(...).
    const global = callee.type === "Identifier" || object === WINDOW;
    const [first] = args;
    if (global && typeof first === "string") {
      try {
        switch (name) {
          case "decodeURIComponent":
            return decodeURIComponent(first);
          case "decodeURI":
            return decodeURI(first);
          case "unescape":
            return unescape(first);
          case "encodeURIComponent":
            return encodeURIComponent(first);
          case "atob":
            return atob(first);
        }
      } catch {
        return UNKNOWN; // a malformed escape: the browser would throw as well
      }
    }
    if (callee.type !== "MemberExpression") return UNKNOWN;
    const receiver = callee.object;
    if (receiver.type === "Identifier" && receiver.name === "JSON" && name === "parse") {
      if (typeof first !== "string") return UNKNOWN;
      try {
        return JSON.parse(first) as Value;
      } catch {
        return UNKNOWN;
      }
    }
    if (receiver.type === "Identifier" && receiver.name === "String" && name === "fromCharCode") {
      return args.every((code) => typeof code === "number")
        ? String.fromCharCode(...(args as number[]))
        : UNKNOWN;
    }
    return name === undefined ? UNKNOWN : callMethod(object, name, args, this, depth);
  }

  /** A value as text, the way JavaScript turns it into a string; null when unknown. */
  asText(value: Value): string | null {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return String(value);
    }
    if (value === LOCATION) return this.page.href;
    if (value instanceof URL || value instanceof URLSearchParams) return value.toString();
    return null;
  }

  /** An array from the code (or one already worked out), with every element known. */
  toArray(value: Value, depth: number): Value[] | null {
    if (Array.isArray(value)) return value as Value[];
    if (!(value instanceof CodeLiteral) || value.node.type !== "ArrayExpression") return null;
    const items: Value[] = [];
    for (const element of value.node.elements) {
      const item =
        element && element.type !== "SpreadElement" ? this.evaluate(element, depth) : UNKNOWN;
      if (item === UNKNOWN) return null;
      items.push(item);
    }
    return items;
  }
}

/**
 * The few string, array and URLSearchParams methods simple redirect pages use. A result longer
 * than MAX_VALUE_LENGTH is refused before it is built: "".replaceAll("", b) or a join of
 * thousands of long parts would take gigabytes.
 */
function callMethod(
  object: Value,
  name: string,
  args: Value[],
  code: PageScripts,
  depth: number,
): Value {
  const [a, b] = args;
  if (typeof object === "string") {
    const text = object;
    // Only text patterns: a regular expression from the page could take forever to run. A "$"
    // in the replacement copies text ("$&" is the match), so the result could be any length.
    const pair = typeof a === "string" && typeof b === "string" && !b.includes("$");
    const range = typeof a === "number" && (b === undefined || typeof b === "number");
    switch (name) {
      case "replace":
        return pair ? text.replace(a, b) : UNKNOWN;
      case "replaceAll": {
        if (!pair) return UNKNOWN;
        // "" matches before every letter and at the end.
        const matches = a === "" ? text.length + 1 : text.split(a).length - 1;
        return text.length + matches * (b.length - a.length) > MAX_VALUE_LENGTH
          ? UNKNOWN
          : text.replaceAll(a, b);
      }
      case "split":
        return typeof a === "string" ? text.split(a) : UNKNOWN;
      case "slice":
        return range ? text.slice(a, b) : UNKNOWN;
      case "substring":
        return range ? text.substring(a, b) : UNKNOWN;
      case "concat":
        return joined([text, ...args], "", code) ?? UNKNOWN;
      case "trim":
        return text.trim();
      case "toLowerCase":
        return text.toLowerCase();
      case "toString":
        return text;
      default:
        return UNKNOWN;
    }
  }
  const items = code.toArray(object, depth);
  if (items !== null) {
    if (name === "reverse") return [...items].reverse();
    if (name === "join" && (a === undefined || typeof a === "string")) {
      return joined(items, a ?? ",", code) ?? UNKNOWN;
    }
    return UNKNOWN;
  }
  if (object instanceof URLSearchParams && name === "get" && typeof a === "string") {
    return object.get(a);
  }
  return (object instanceof URL || object instanceof URLSearchParams) && name === "toString"
    ? object.toString()
    : UNKNOWN;
}

/** The values as text, joined by `separator`; null when one is unknown or the whole too long. */
function joined(values: Value[], separator: string, code: PageScripts): string | null {
  const parts: string[] = [];
  let length = separator.length * (values.length - 1);
  for (const value of values) {
    const part = code.asText(value);
    if (part === null) return null;
    length += part.length;
    parts.push(part);
  }
  return length > MAX_VALUE_LENGTH ? null : parts.join(separator);
}

/**
 * Every node of a syntax tree with its parent, in source order. A loop, not recursion, so a
 * deeply nested tree costs no call stack.
 */
function* walk(root: AnyNode): Generator<[AnyNode, AnyNode | undefined]> {
  const stack: [AnyNode, AnyNode | undefined][] = [[root, undefined]];
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    yield entry;
    const [node] = entry;
    const children = Object.values(node).flatMap((value) =>
      (Array.isArray(value) ? value : [value]).filter(isNode),
    );
    // Pushed last-first, so that the first child comes off the stack first.
    for (const child of children.reverse()) stack.push([child, node]);
  }
}

function isNode(value: unknown): value is AnyNode {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
  );
}

function isFunction(node: AnyNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** The expression sends the browser elsewhere whichever way its tests go (window.open aside). */
function isLeaving(node: AnyNode): boolean {
  switch (node.type) {
    case "AssignmentExpression":
      return node.operator === "=" && (isLocation(node.left) || isLocationHref(node.left));
    case "CallExpression":
      return isLocationCall(node);
    case "ConditionalExpression":
      return isLeaving(node.consequent) && isLeaving(node.alternate);
    case "SequenceExpression":
      return node.expressions.some(isLeaving);
    default:
      return false;
  }
}

/** n--, n -= 1 or n = n - 1: a counter counting. */
function isCountingStep(value: AnyNode | null, name: string): boolean {
  if (value?.type === "UpdateExpression") return true;
  if (value?.type === "AssignmentExpression")
    return value.operator === "-=" || value.operator === "+=";
  if (value?.type !== "BinaryExpression" || (value.operator !== "-" && value.operator !== "+")) {
    return false;
  }
  const sides = [value.left, value.right];
  return (
    sides.some((side) => side.type === "Identifier" && side.name === name) &&
    sides.some((side) => side.type === "Literal" && typeof side.value === "number")
  );
}

function propertyName(node: AnyNode): string | undefined {
  if (node.type !== "MemberExpression") return undefined;
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : undefined;
}

function calleeName(call: CallExpression): string | undefined {
  return call.callee.type === "Identifier" ? call.callee.name : propertyName(call.callee);
}

/** window, self, top, parent, globalThis, this, document, and chains such as window.top. */
function isWindowLike(node: AnyNode): boolean {
  let at = node;
  // A loop, not recursion: window.top.top.top... can be thousands of names long.
  while (at.type === "MemberExpression") {
    const name = propertyName(at);
    if (name === undefined || !WINDOW_NAMES.has(name)) return false;
    at = at.object;
  }
  if (at.type === "Identifier") return WINDOW_NAMES.has(at.name) || at.name === "document";
  return at.type === "ThisExpression";
}

/** `location`, `window.location`, `document.location`, `top.location`, `window["location"]`... */
function isLocation(node: AnyNode): boolean {
  if (node.type === "Identifier") return node.name === "location";
  return (
    node.type === "MemberExpression" &&
    propertyName(node) === "location" &&
    isWindowLike(node.object)
  );
}

function isLocationHref(node: AnyNode): boolean {
  return (
    node.type === "MemberExpression" && propertyName(node) === "href" && isLocation(node.object)
  );
}

/** location.replace(url) and location.assign(url). */
function isLocationCall(call: CallExpression): boolean {
  const method = propertyName(call.callee);
  return (
    (method === "replace" || method === "assign") &&
    call.callee.type === "MemberExpression" &&
    isLocation(call.callee.object)
  );
}

function isWindowOpen(call: CallExpression): boolean {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name === "open";
  return (
    propertyName(callee) === "open" &&
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    WINDOW_NAMES.has(callee.object.name)
  );
}

function isTimer(call: CallExpression): boolean {
  const name = calleeName(call);
  return name !== undefined && TIMERS.has(name);
}

/** setTimeout(node, ...) and the like. */
function isTimerArgument(node: AnyNode, parent: AnyNode): boolean {
  return parent.type === "CallExpression" && parent.arguments[0] === node && isTimer(parent);
}

function isOnloadProperty(node: AnyNode): boolean {
  if (node.type === "Identifier") return node.name === "onload";
  const name = propertyName(node);
  return name === "onload" || name === "onpageshow";
}

/** The name a function is known by: `function go()`, `var go = function`, `go = () => ...`. */
function functionName(fn: AnyNode, parent: AnyNode): string | undefined {
  if (fn.type === "FunctionDeclaration") return fn.id?.name;
  if (
    parent.type === "VariableDeclarator" &&
    parent.init === fn &&
    parent.id.type === "Identifier"
  ) {
    return parent.id.name;
  }
  return parent.type === "AssignmentExpression" &&
    parent.right === fn &&
    parent.left.type === "Identifier"
    ? parent.left.name
    : undefined;
}

/** Every name a declaration pattern binds: `a`, `{ a, b: [c] }`, `...rest`, `x = 1`. */
function patternNames(pattern: AnyNode): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        patternNames(property.type === "RestElement" ? property.argument : property.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) => (element ? patternNames(element) : []));
    case "RestElement":
      return patternNames(pattern.argument);
    case "AssignmentPattern":
      return patternNames(pattern.left);
    default:
      return []; // assigning to obj.prop binds no name
  }
}

function withoutFragment(url: URL): string {
  return url.href.replace(/#.*/s, "");
}

/** The answer kept in `answers` for `key`, worked out by `find` the first time it is asked. */
function remember<K, V>(answers: Map<K, V>, key: K, find: () => V): V {
  if (!answers.has(key)) answers.set(key, find());
  return answers.get(key) as V;
}
