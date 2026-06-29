import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ParentExtensionUIBridgeProxy, type ParentBridge } from "../src/parent-extension-ui-bridge-proxy.js";

// ── Mock ParentBridge ──────────────────────────────────────────────────────

function createMockParentBridge(): ParentBridge & {
  calls: Record<string, { args: unknown[] }[]>;
} {
  const calls: Record<string, { args: unknown[] }[]> = {
    select: [],
    confirm: [],
    input: [],
    notify: [],
    cancelAll: [],
  };

  return {
    calls,
    async select(title, options, opts) {
      calls.select.push({ args: [title, options, opts] });
      return "mock-selected";
    },
    async confirm(title, message, opts) {
      calls.confirm.push({ args: [title, message, opts] });
      return true;
    },
    async input(title, placeholder, opts) {
      calls.input.push({ args: [title, placeholder, opts] });
      return "mock-input";
    },
    notify(message, type, subagentCallId) {
      calls.notify.push({ args: [message, type, subagentCallId] });
    },
    cancelAll() {
      calls.cancelAll.push({ args: [] });
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ParentExtensionUIBridgeProxy", () => {
  const CALL_ID = "sub-call-123";
  let mock: ReturnType<typeof createMockParentBridge>;
  let proxy: ParentExtensionUIBridgeProxy;

  beforeEach(() => {
    mock = createMockParentBridge();
    proxy = new ParentExtensionUIBridgeProxy(mock, CALL_ID);
  });

  // ── Dialog methods ──────────────────────────────────────────────────────

  describe("select", () => {
    it("delegates to parent bridge with subagentCallId stamped", async () => {
      const ac = new AbortController();
      const result = await proxy.select("Pick one", ["a", "b"], { signal: ac.signal });

      assert.equal(result, "mock-selected");
      assert.equal(mock.calls.select.length, 1);
      const { args } = mock.calls.select[0];
      assert.equal(args[0], "Pick one");
      assert.deepEqual(args[1], ["a", "b"]);
      assert.deepEqual(args[2], { signal: ac.signal, subagentCallId: CALL_ID, toolCallId: CALL_ID });
    });

    it("passes undefined signal when opts omitted", async () => {
      await proxy.select("Title", ["x"]);

      const opts = mock.calls.select[0].args[2] as { signal?: AbortSignal; subagentCallId?: string; toolCallId?: string };
      assert.equal(opts.signal, undefined);
      assert.equal(opts.subagentCallId, CALL_ID);
      assert.equal(opts.toolCallId, CALL_ID);
    });
  });

  describe("confirm", () => {
    it("delegates to parent bridge with subagentCallId stamped", async () => {
      const ac = new AbortController();
      const result = await proxy.confirm("Really?", "Are you sure?", { signal: ac.signal });

      assert.equal(result, true);
      assert.equal(mock.calls.confirm.length, 1);
      const { args } = mock.calls.confirm[0];
      assert.equal(args[0], "Really?");
      assert.equal(args[1], "Are you sure?");
      assert.deepEqual(args[2], { signal: ac.signal, subagentCallId: CALL_ID, toolCallId: CALL_ID });
    });

    it("passes undefined signal when opts omitted", async () => {
      await proxy.confirm("Title", "Msg");

      const opts = mock.calls.confirm[0].args[2] as { signal?: AbortSignal; subagentCallId?: string; toolCallId?: string };
      assert.equal(opts.signal, undefined);
      assert.equal(opts.subagentCallId, CALL_ID);
      assert.equal(opts.toolCallId, CALL_ID);
    });
  });

  describe("input", () => {
    it("delegates to parent bridge with subagentCallId stamped", async () => {
      const ac = new AbortController();
      const result = await proxy.input("Enter value", "placeholder", { signal: ac.signal });

      assert.equal(result, "mock-input");
      assert.equal(mock.calls.input.length, 1);
      const { args } = mock.calls.input[0];
      assert.equal(args[0], "Enter value");
      assert.equal(args[1], "placeholder");
      assert.deepEqual(args[2], { signal: ac.signal, subagentCallId: CALL_ID, toolCallId: CALL_ID });
    });

    it("passes undefined signal when opts omitted", async () => {
      await proxy.input("Title");

      const opts = mock.calls.input[0].args[2] as { signal?: AbortSignal; subagentCallId?: string; toolCallId?: string };
      assert.equal(opts.signal, undefined);
      assert.equal(opts.subagentCallId, CALL_ID);
      assert.equal(opts.toolCallId, CALL_ID);
    });
  });

  describe("notify", () => {
    it("delegates to parent bridge with subagentCallId stamped", () => {
      proxy.notify("Something happened", "warning");

      assert.equal(mock.calls.notify.length, 1);
      const { args } = mock.calls.notify[0];
      assert.equal(args[0], "Something happened");
      assert.equal(args[1], "warning");
      assert.equal(args[2], CALL_ID);
    });

    it("passes undefined type when omitted", () => {
      proxy.notify("Info only");

      const { args } = mock.calls.notify[0];
      assert.equal(args[0], "Info only");
      assert.equal(args[1], undefined);
      assert.equal(args[2], CALL_ID);
    });
  });

  // ── TUI methods (all no-ops / empty / undefined) ───────────────────────

  describe("TUI no-op methods", () => {
    it("onTerminalInput returns a no-op unsubscribe function", () => {
      const unsub = proxy.onTerminalInput();
      assert.equal(typeof unsub, "function");
      assert.equal(unsub(), undefined);
    });

    it("setStatus is a no-op", () => {
      assert.equal(proxy.setStatus(), undefined);
    });

    it("setWorkingMessage is a no-op", () => {
      assert.equal(proxy.setWorkingMessage(), undefined);
    });

    it("setWorkingVisible is a no-op", () => {
      assert.equal(proxy.setWorkingVisible(), undefined);
    });

    it("setWorkingIndicator is a no-op", () => {
      assert.equal(proxy.setWorkingIndicator(), undefined);
    });

    it("setHiddenThinkingLabel is a no-op", () => {
      assert.equal(proxy.setHiddenThinkingLabel(), undefined);
    });

    it("setWidget is a no-op", () => {
      assert.equal(proxy.setWidget(), undefined);
    });

    it("setFooter is a no-op", () => {
      assert.equal(proxy.setFooter(), undefined);
    });

    it("setHeader is a no-op", () => {
      assert.equal(proxy.setHeader(), undefined);
    });

    it("setTitle is a no-op", () => {
      assert.equal(proxy.setTitle(), undefined);
    });

    it("pasteToEditor is a no-op", () => {
      assert.equal(proxy.pasteToEditor(), undefined);
    });

    it("setEditorText is a no-op", () => {
      assert.equal(proxy.setEditorText(), undefined);
    });

    it("addAutocompleteProvider is a no-op", () => {
      assert.equal(proxy.addAutocompleteProvider(), undefined);
    });

    it("setEditorComponent is a no-op", () => {
      assert.equal(proxy.setEditorComponent(), undefined);
    });

    it("setToolsExpanded is a no-op", () => {
      assert.equal(proxy.setToolsExpanded(), undefined);
    });
  });

  describe("TUI methods returning empty/undefined values", () => {
    it("getEditorText returns empty string", () => {
      assert.equal(proxy.getEditorText(), "");
    });

    it("editor resolves to undefined", async () => {
      assert.equal(await proxy.editor(), undefined);
    });

    it("getEditorComponent returns undefined", () => {
      assert.equal(proxy.getEditorComponent(), undefined);
    });

    it("theme returns empty object", () => {
      assert.deepEqual(proxy.theme, {});
    });

    it("getAllThemes returns empty array", () => {
      assert.deepEqual(proxy.getAllThemes(), []);
    });

    it("getTheme returns undefined", () => {
      assert.equal(proxy.getTheme(), undefined);
    });

    it("getToolsExpanded returns false", () => {
      assert.equal(proxy.getToolsExpanded(), false);
    });

    it("setTheme returns failure result", () => {
      const result = proxy.setTheme();
      assert.deepEqual(result, { success: false, error: "not available in subagent" });
    });
  });

  describe("custom", () => {
    it("throws an error", async () => {
      await assert.rejects(
        () => proxy.custom<never>(),
        { message: "custom() not available in subagent sessions" },
      );
    });
  });

  // ── cancelAll delegates to the parent bridge ───────────────────────────

  describe("cancelAll", () => {
    it("is a method on the proxy class", () => {
      assert.equal(typeof (proxy as any).cancelAll, "function");
    });

    it("delegates to the parent bridge's cancelAll", () => {
      proxy.cancelAll();
      assert.equal(mock.calls.cancelAll.length, 1);
    });
  });
});
