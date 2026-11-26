import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  CHROME_LAYOUT_KEY,
  CHROME_LAYOUT_SCRIPT,
  CHROME_LAYOUT_VARS,
  measureChromeLayout,
  readChromeLayout,
  writeChromeLayout,
} from "./chrome-layout-hint";

/** Runs the before-paint script against a stored value; returns the custom properties it set. */
function runScript(stored: string | null, storageThrows = false): Record<string, string> {
  const set: Record<string, string> = {};
  const localStorage = {
    getItem: (key: string) => {
      if (storageThrows) throw new Error("blocked");
      return key === CHROME_LAYOUT_KEY ? stored : null;
    },
  };
  const document = { documentElement: { style: { setProperty: (name: string, value: string) => { set[name] = value; } } } };
  new Function("localStorage", "document", CHROME_LAYOUT_SCRIPT)(localStorage, document);
  return set;
}

describe("before-paint script", () => {
  test("sets the remembered widths and hides slots the last ready render did not have", () => {
    expect(runScript(JSON.stringify({ balance: 41.5, upgrade: 99, invite: 0, newProject: false }))).toEqual({
      [CHROME_LAYOUT_VARS.balance]: "41.5px",
      [CHROME_LAYOUT_VARS.upgrade]: "99px",
      [CHROME_LAYOUT_VARS.invite]: "0px",
      [CHROME_LAYOUT_VARS.inviteDisplay]: "none",
      [CHROME_LAYOUT_VARS.newProjectDisplay]: "none",
    });
    expect(runScript(JSON.stringify({ balance: 33, upgrade: 0, invite: 104, newProject: true }))).toEqual({
      [CHROME_LAYOUT_VARS.balance]: "33px",
      [CHROME_LAYOUT_VARS.upgrade]: "0px",
      [CHROME_LAYOUT_VARS.invite]: "104px",
    });
  });

  test("ignores missing, malformed and out-of-range values, field by field", () => {
    for (const stored of [null, "", "not json", "null", "42", '"x"', "[1,2]", "{}"]) {
      expect(runScript(stored)).toEqual({});
    }
    expect(
      runScript(
        JSON.stringify({ balance: -1, upgrade: 1e9, invite: "80", newProject: "false", extra: "x" }),
      ),
    ).toEqual({});
    // JSON cannot carry NaN or Infinity; a huge exponent parses to Infinity and is refused.
    expect(runScript('{"balance":1e400,"upgrade":"1px","invite":{"a":1},"newProject":0}')).toEqual({});
    expect(runScript(JSON.stringify({ balance: "40; color: red", invite: 80 }))).toEqual({
      [CHROME_LAYOUT_VARS.invite]: "80px",
    });
    expect(runScript("{}", true)).toEqual({});
  });
});

describe("stored hint", () => {
  function memoryStorage(initial: string | null = null) {
    let value = initial;
    let writes = 0;
    return {
      getItem: (key: string) => (key === CHROME_LAYOUT_KEY ? value : null),
      setItem: (key: string, next: string) => {
        expect(key).toBe(CHROME_LAYOUT_KEY);
        value = next;
        writes += 1;
      },
      get value() {
        return value;
      },
      get writes() {
        return writes;
      },
    };
  }

  test("holds only widths and a boolean, and writes only when a value changed", () => {
    const storage = memoryStorage();
    writeChromeLayout(storage, { balance: 34.25, upgrade: 99.5, invite: 104, newProject: true });
    expect(JSON.parse(storage.value ?? "")).toEqual({ balance: 34.25, upgrade: 99.5, invite: 104, newProject: true });
    expect(Object.keys(JSON.parse(storage.value ?? "")).sort()).toEqual(["balance", "invite", "newProject", "upgrade"]);
    writeChromeLayout(storage, { balance: 34.25, upgrade: 99.5, invite: 104, newProject: true });
    expect(storage.writes).toBe(1);
  });

  test("a slot not seen this time keeps its last value", () => {
    const storage = memoryStorage(JSON.stringify({ balance: 34, upgrade: 0, invite: 80, newProject: true }));
    writeChromeLayout(storage, { newProject: false });
    expect(JSON.parse(storage.value ?? "")).toEqual({ balance: 34, upgrade: 0, invite: 80, newProject: false });
  });

  test("drops corrupt stored fields and never throws when storage refuses", () => {
    const storage = memoryStorage('{"balance":"x","upgrade":5,"name":"Ada","workspaceId":"w"}');
    writeChromeLayout(storage, { invite: 0, newProject: true });
    expect(JSON.parse(storage.value ?? "")).toEqual({ upgrade: 5, invite: 0, newProject: true });
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeChromeLayout(refusing, { newProject: true })).not.toThrow();
    expect(() => writeChromeLayout(null, { newProject: true })).not.toThrow();
    expect(readChromeLayout("{")).toEqual({});
  });
});

describe("measurement", () => {
  function chrome(html: string, rects: Record<string, number>) {
    const window = new Window();
    window.document.body.innerHTML = html;
    for (const element of window.document.querySelectorAll("[data-w]")) {
      const width = rects[element.getAttribute("data-w") ?? ""] ?? 0;
      element.getBoundingClientRect = () => ({ width }) as DOMRect;
    }
    return window.document;
  }
  const pill = (upgrade: boolean) => `
    <div data-chrome-slot="credits" data-w="pill" style="padding-left: 2px; padding-right: 2px">
      <button data-chrome-slot="credits-trigger" data-w="trigger"><span data-chrome-slot="balance" data-w="balance">9</span></button>
      ${upgrade ? "<a>Upgrade</a>" : ""}
    </div>`;

  test("the pill beyond its trigger is the Upgrade button and its gap; an absent Invite is zero", () => {
    const document = chrome(`<header data-chrome-top-bar data-w="bar">${pill(true)}</header>`, {
      bar: 900,
      pill: 4 + 80 + 4 + 95,
      trigger: 80,
      balance: 33.333,
    });
    expect(measureChromeLayout(document as unknown as ParentNode)).toEqual({ upgrade: 99, balance: 33.33, invite: 0 });
  });

  test("a slot that is not laid out or not on the page is left out", () => {
    const hidden = chrome(`<header data-chrome-top-bar data-w="bar"><a data-chrome-slot="invite" data-w="invite">Invite</a>${pill(false)}</header>`, {
      bar: 0,
      pill: 0,
    });
    expect(measureChromeLayout(hidden as unknown as ParentNode)).toEqual({});
    // The upload funnel: a pill but no top bar with an Invite slot.
    const focused = chrome(`<header>${pill(false)}</header>`, { pill: 88, trigger: 84, balance: 33 });
    expect(measureChromeLayout(focused as unknown as ParentNode)).toEqual({ upgrade: 0, balance: 33 });
  });
});
