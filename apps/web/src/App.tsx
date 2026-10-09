import type { ResolveResult } from "@urlresolve/types";
import { type FormEvent, useState } from "react";
import { apiProblem, view } from "./view.ts";

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; result: ResolveResult }
  | { kind: "failed"; message: string };

export function App() {
  const [link, setLink] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function resolve(event: FormEvent) {
    event.preventDefault();
    setState({ kind: "busy" });
    try {
      const answer = await fetch("/api/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: link.trim() }),
      });
      if (!answer.ok) {
        setState({ kind: "failed", message: apiProblem(answer.status) });
        return;
      }
      setState({ kind: "done", result: await answer.json() });
    } catch {
      setState({ kind: "failed", message: "The server could not be reached." });
    }
  }

  return (
    <main>
      <h1>Universal URL Resolver</h1>
      <form onSubmit={resolve}>
        <label htmlFor="link">Short link</label>
        <div className="row">
          <input
            id="link"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste URL here"
            required
            maxLength={8192}
            value={link}
            onChange={(event) => setLink(event.target.value)}
          />
          <button type="submit" disabled={state.kind === "busy"}>
            {state.kind === "busy" ? "Resolving…" : "Resolve"}
          </button>
        </div>
      </form>
      <section aria-live="polite">
        {state.kind === "failed" && <p className="problem">{state.message}</p>}
        {state.kind === "done" && <Report result={state.result} />}
      </section>
    </main>
  );
}

function Report({ result }: { result: ResolveResult }) {
  const shown = view(result);
  const { names, cleanUrl } = shown.tracking;
  return (
    <div className="report">
      <h2>{shown.resolved ? "Final URL" : shown.headline}</h2>
      {shown.resolved ? (
        <p className="url">{shown.headline}</p>
      ) : (
        <p className="reason">{shown.reason}</p>
      )}

      {shown.chain.length > 0 && (
        <>
          <h2>Redirect chain</h2>
          <ol className="chain">
            {shown.chain.map((step) => (
              <li key={step.position}>
                <strong>{step.host}</strong>
                <span className="url">{step.href}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      {shown.security.length > 0 && (
        <>
          <h2>Security</h2>
          <ul className="checks">
            {shown.security.map((check) => (
              <li key={check.text} className={check.ok ? "ok" : "bad"}>
                {check.ok ? "✓" : "✗"} {check.text}
              </li>
            ))}
          </ul>
        </>
      )}

      {shown.resolved && (
        <>
          <h2>Tracking</h2>
          <p>
            {names.length === 0
              ? "No tracking parameters"
              : `${names.length} tracking parameter${names.length === 1 ? "" : "s"}: ${names.join(", ")}`}
          </p>
          {cleanUrl !== null && (
            <p>
              Without them: <span className="url">{cleanUrl}</span>
            </p>
          )}
        </>
      )}

      <h2>Technical</h2>
      <ul className="technical">
        {shown.technical.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
