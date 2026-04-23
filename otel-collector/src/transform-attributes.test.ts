import { describe, it, expect } from "vitest";
import {
  anyValueToString,
  convertAttributes,
  getServiceName,
  nanosToRFC3339,
  convertExemplars,
  getNumberValue,
} from "./transform-attributes.ts";

describe("anyValueToString", () => {
  it("handles undefined", () => {
    expect(anyValueToString(undefined)).toBe("");
  });

  it("handles stringValue", () => {
    expect(anyValueToString({ stringValue: "hello" })).toBe("hello");
  });

  it("handles intValue (string in JSON)", () => {
    expect(anyValueToString({ intValue: "42" })).toBe("42");
  });

  it("handles intValue when numeric payloads slip through", () => {
    expect(anyValueToString({ intValue: 42 as never })).toBe("42");
  });

  it("handles doubleValue", () => {
    expect(anyValueToString({ doubleValue: 3.14 })).toBe("3.14");
  });

  it("handles boolValue true", () => {
    expect(anyValueToString({ boolValue: true })).toBe("true");
  });

  it("handles boolValue false", () => {
    expect(anyValueToString({ boolValue: false })).toBe("false");
  });

  it("handles arrayValue", () => {
    expect(
      anyValueToString({
        arrayValue: {
          values: [{ stringValue: "a" }, { stringValue: "b" }],
        },
      }),
    ).toMatchInlineSnapshot(`"["a","b"]"`);
  });

  it("handles kvlistValue", () => {
    expect(
      anyValueToString({
        kvlistValue: {
          values: [{ key: "foo", value: { stringValue: "bar" } }],
        },
      }),
    ).toMatchInlineSnapshot(`"{"foo":"bar"}"`);
  });

  it("handles bytesValue", () => {
    expect(anyValueToString({ bytesValue: "AQID" })).toBe("AQID");
  });

  it("handles empty object", () => {
    expect(anyValueToString({})).toBe("");
  });
});

describe("convertAttributes", () => {
  it("handles undefined", () => {
    expect(convertAttributes(undefined)).toMatchInlineSnapshot(`{}`);
  });

  it("handles empty array", () => {
    expect(convertAttributes([])).toMatchInlineSnapshot(`{}`);
  });

  it("converts mixed attribute types to strings", () => {
    const result = convertAttributes([
      { key: "str", value: { stringValue: "hello" } },
      { key: "num", value: { intValue: "42" } },
      { key: "dbl", value: { doubleValue: 1.5 } },
      { key: "bool", value: { boolValue: true } },
    ]);
    expect(result).toMatchInlineSnapshot(`
      {
        "bool": "true",
        "dbl": "1.5",
        "num": "42",
        "str": "hello",
      }
    `);
  });

  it("stringifies numeric intValue fields inside attribute maps", () => {
    const result = convertAttributes([
      { key: "process.pid", value: { intValue: 58160 as never } },
      { key: "http.status_code", value: { intValue: 200 as never } },
    ]);
    expect(result).toMatchInlineSnapshot(`
      {
        "http.status_code": "200",
        "process.pid": "58160",
      }
    `);
  });
});

describe("getServiceName", () => {
  it("returns empty for undefined", () => {
    expect(getServiceName(undefined)).toBe("");
  });

  it("returns empty when no service.name", () => {
    expect(getServiceName([{ key: "other", value: { stringValue: "val" } }])).toBe("");
  });

  it("extracts service.name", () => {
    expect(getServiceName([{ key: "service.name", value: { stringValue: "my-service" } }])).toBe("my-service");
  });
});

describe("nanosToRFC3339", () => {
  it("converts nanoseconds to RFC3339 with nanosecond precision", () => {
    // 2018-12-13T14:51:00.000000000Z
    const result = nanosToRFC3339("1544712660000000000");
    expect(result).toMatchInlineSnapshot(`"2018-12-13T14:51:00.000000000Z"`);
  });

  it("preserves nanosecond precision", () => {
    const result = nanosToRFC3339("1544712660123456789");
    expect(result).toMatchInlineSnapshot(`"2018-12-13T14:51:00.123456789Z"`);
  });

  it("handles zero", () => {
    const result = nanosToRFC3339("0");
    expect(result).toMatchInlineSnapshot(`"1970-01-01T00:00:00.000000000Z"`);
  });
});

describe("convertExemplars", () => {
  it("handles undefined", () => {
    expect(convertExemplars(undefined)).toMatchInlineSnapshot(`
      {
        "exemplars_filtered_attributes": [],
        "exemplars_span_id": [],
        "exemplars_timestamp": [],
        "exemplars_trace_id": [],
        "exemplars_value": [],
      }
    `);
  });

  it("handles empty array", () => {
    expect(convertExemplars([])).toMatchInlineSnapshot(`
      {
        "exemplars_filtered_attributes": [],
        "exemplars_span_id": [],
        "exemplars_timestamp": [],
        "exemplars_trace_id": [],
        "exemplars_value": [],
      }
    `);
  });

  it("converts exemplars with double values", () => {
    const result = convertExemplars([
      {
        timeUnixNano: "1544712660000000000",
        asDouble: 42.5,
        spanId: "abc123",
        traceId: "def456",
        filteredAttributes: [{ key: "filter", value: { stringValue: "yes" } }],
      },
    ]);
    expect(result).toMatchInlineSnapshot(`
      {
        "exemplars_filtered_attributes": [
          {
            "filter": "yes",
          },
        ],
        "exemplars_span_id": [
          "abc123",
        ],
        "exemplars_timestamp": [
          "2018-12-13T14:51:00.000000000Z",
        ],
        "exemplars_trace_id": [
          "def456",
        ],
        "exemplars_value": [
          42.5,
        ],
      }
    `);
  });
});

describe("getNumberValue", () => {
  it("returns asInt as number", () => {
    expect(getNumberValue({ asInt: "100" })).toBe(100);
  });

  it("returns asDouble", () => {
    expect(getNumberValue({ asDouble: 3.14 })).toBe(3.14);
  });

  it("returns 0 when neither set", () => {
    expect(getNumberValue({})).toBe(0);
  });

  it("prefers asInt over asDouble", () => {
    expect(getNumberValue({ asInt: "10", asDouble: 20 })).toBe(10);
  });
});
