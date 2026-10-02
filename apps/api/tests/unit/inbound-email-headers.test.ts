/**
 * The IMAP worker hands the intake pipeline the headers its loop guard and reply threading read.
 *
 * Driven through mailparser's real `simpleParser` on raw RFC 5322 text, because the shapes are the
 * trap: Return-Path arrives as an address object (whose empty rendering IS the null return path),
 * List-Id arrives folded into a `list` header, and References is one id or an array depending on
 * how many there are. A hand-built stand-in would agree with whatever the extraction assumed.
 */
import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";

const { toParsedInboundEmail } = await import("../../src/workers/inbound-email.worker.js");

const raw = (headers: string[]) => [...headers, "", "body text", ""].join("\r\n");

describe("toParsedInboundEmail", () => {
  it("carries the automated-mail signals of a bounce or list message", async () => {
    const parsed = await simpleParser(
      raw([
        "Return-Path: <>",
        "From: Mail Delivery <mailer-daemon@mx.example.com>",
        "To: support@acme.test",
        "Subject: Undelivered Mail",
        "Auto-Submitted: auto-replied",
        "Precedence: bulk",
        "List-Id: Announce <announce.lists.example.com>"
      ])
    );
    const email = toParsedInboundEmail(parsed);
    expect(email.headers).toMatchObject({
      autoSubmitted: "auto-replied",
      precedence: "bulk",
      listId: "announce.lists.example.com",
      returnPath: ""
    });
  });

  it("carries the threading headers of a reply, References as a list either way", async () => {
    const one = toParsedInboundEmail(
      await simpleParser(raw(["From: casey@example.com", "To: support@acme.test", "Subject: Re: hi", "In-Reply-To: <a@b>", "References: <a@b>"]))
    );
    expect(one.headers).toMatchObject({ inReplyTo: "<a@b>", references: ["<a@b>"] });

    const many = toParsedInboundEmail(
      await simpleParser(raw(["From: casey@example.com", "To: support@acme.test", "Subject: Re: hi", "References: <a@b> <c@d>"]))
    );
    expect(many.headers?.references).toEqual(["<a@b>", "<c@d>"]);
  });

  it("leaves a person's ordinary message without any automated signal", async () => {
    const email = toParsedInboundEmail(
      await simpleParser(raw(["Return-Path: <casey@example.com>", "From: Casey <casey@example.com>", "To: support@acme.test", "Subject: Login broken"]))
    );
    expect(email.from).toEqual({ address: "casey@example.com", name: "Casey" });
    expect(email.headers).toMatchObject({ returnPath: "casey@example.com", autoSubmitted: undefined, precedence: undefined, listId: undefined });
  });
});
