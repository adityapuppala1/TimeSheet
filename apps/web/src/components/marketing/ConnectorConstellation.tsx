/**
 * WHAT: the systems TimeSphere connects to, drawn as a hub with light travelling along each spoke.
 *
 * WHY THIS REPLACED THE SCROLLING STRIP: a marquee shows one thing at a time and says nothing about
 * direction. This says the thing that actually matters about these integrations — everything meets
 * in one place, and traffic runs both ways: identity and messages and commits come IN, mail and
 * billing and AI calls go OUT. That is the product's whole shape in one picture.
 *
 * THE SAME RULE STILL APPLIES, and it is the reason this is grouped rather than a logo wall.
 * `docs/MARKETING_PAGES.md` forbids customer logos ("there are no customer counts, revenue figures
 * or logos on these pages, because there are none to cite"), and every node below is instead a
 * family of SHIPPED connectors — each with a controller, a settings surface and a row in the docs.
 * The names under each node are the real ones, so the claim stays checkable.
 *
 * WHY CATEGORY GLYPHS AND NOT VENDOR MARKS: eighteen brand SVGs is a great deal of vendored path
 * data to carry on the one page whose job is to load fast, and half of them (IMAP, SMTP, LDAP,
 * SAML, MCP) are protocols with no mark to reproduce — so a mixed row would have looked like six
 * logos and six shrugs. The glyphs also inherit the theme, which a fixed-colour logo cannot.
 *
 * ACCESSIBILITY: the diagram is decorative on top of a real list. The beams are `aria-hidden`, and
 * each node is a labelled item, so a screen reader gets "Identity: Google, Microsoft/Entra, SAML
 * 2.0, LDAP" rather than an SVG soup.
 */
import { useRef, type ReactNode, type RefObject } from "react";
import { Bot, CreditCard, GitBranch, KeyRound, Mail, MessageSquare } from "lucide-react";
import { AnimatedBeam } from "./AnimatedBeam";
import { connectorsIn, CONNECTOR_COUNT, type ConnectorGroup } from "./connectors";

interface NodeSpec {
  group: ConnectorGroup;
  label: string;
  Icon: typeof KeyRound;
  /** Which way the light runs. Inbound = the outside system feeds TimeSphere. */
  direction: "in" | "out";
}

/** Six families. The MEMBERS are not listed here — they are read from connectors.ts, so adding a
 *  connector there puts it on this diagram and in the stat band's count at the same time. */
const NODE_SPECS: NodeSpec[] = [
  { group: "identity", label: "Identity", Icon: KeyRound, direction: "in" },
  { group: "chat", label: "Chat", Icon: MessageSquare, direction: "in" },
  { group: "code", label: "Code & CI", Icon: GitBranch, direction: "in" },
  { group: "mail", label: "Mail", Icon: Mail, direction: "out" },
  { group: "ai", label: "AI", Icon: Bot, direction: "out" },
  { group: "billing", label: "Billing", Icon: CreditCard, direction: "out" }
];

const NODES = NODE_SPECS.map((spec) => ({ ...spec, members: connectorsIn(spec.group) }));

function NodeCircle({ nodeRef, children, className = "" }: { nodeRef: RefObject<HTMLDivElement | null>; children: ReactNode; className?: string }) {
  return (
    <div
      ref={nodeRef}
      className={`z-10 grid h-12 w-12 place-items-center rounded-full border border-border bg-card text-primary shadow-soft transition-colors duration-200 ${className}`}
    >
      {children}
    </div>
  );
}

export function ConnectorConstellation() {
  const container = useRef<HTMLDivElement>(null);
  const hub = useRef<HTMLDivElement>(null);
  // One ref per node, declared individually because hooks cannot be called in a loop.
  const r0 = useRef<HTMLDivElement>(null);
  const r1 = useRef<HTMLDivElement>(null);
  const r2 = useRef<HTMLDivElement>(null);
  const r3 = useRef<HTMLDivElement>(null);
  const r4 = useRef<HTMLDivElement>(null);
  const r5 = useRef<HTMLDivElement>(null);
  const refs = [r0, r1, r2, r3, r4, r5];

  const left = NODES.slice(0, 3);
  const right = NODES.slice(3);

  /*
    THE CIRCLE SITS ON THE INNER EDGE OF EACH COLUMN, nearest the hub, and the text on the outer
    edge. That is not styling — it is what keeps the beams off the labels. Drawn the other way
    round (text between the circle and the hub, which is what this did first) every curve runs
    straight through its own caption, and the first render had a beam struck through "SAML 2.0".
  */
  const column = (nodes: typeof NODES, offset: number, side: "left" | "right") => (
    <div className="flex flex-col justify-between gap-6">
      {nodes.map((node, i) => {
        const index = offset + i;
        return (
          <div
            key={node.group}
            className={`flex items-center gap-3 ${side === "left" ? "flex-row-reverse text-right" : ""}`}
          >
            <NodeCircle nodeRef={refs[index]}>
              <node.Icon className="h-5 w-5" aria-hidden />
            </NodeCircle>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{node.label}</p>
              {/* Each connector with its own mark rather than a dot-separated list of words — the
                  logos are what people scan for, and "is my stack in there" is the only question
                  this strip exists to answer.

                  Hidden below sm: at phone width these wrap into several lines per group and the
                  diagram stops being a diagram. The circles and the beams still carry the idea. */}
              <ul
                className={`mt-1 hidden flex-wrap gap-x-3 gap-y-1 sm:flex ${side === "left" ? "justify-end" : ""}`}
              >
                {node.members.map((member) => (
                  <li key={member.name} className="inline-flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
                    <member.Mark className="h-3.5 w-3.5 shrink-0" />
                    {member.name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div
      ref={container}
      className="relative mx-auto flex w-full max-w-4xl items-center justify-between gap-4 overflow-hidden px-2 py-8 sm:gap-10 sm:px-6"
      role="img"
      aria-label={`TimeSphere connects to ${CONNECTOR_COUNT} systems: ${NODES.map((n) => `${n.label} — ${n.members.map((m) => m.name).join(", ")}`).join("; ")}`}
    >
      {column(left, 0, "left")}

      <div
        ref={hub}
        className="z-10 grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-primary text-lg font-black text-primary-foreground shadow-glow"
      >
        T
      </div>

      {column(right, 3, "right")}

      {/* Inbound beams run toward the hub, outbound away from it — `reverse` is what encodes that,
          and it is the only reason the direction field exists. Delays are staggered so six beams
          read as traffic rather than as a heartbeat. */}
      {NODES.map((node, i) => (
        <AnimatedBeam
          key={node.group}
          containerRef={container}
          fromRef={refs[i]}
          toRef={hub}
          curvature={i % 3 === 0 ? 40 : i % 3 === 2 ? -40 : 0}
          reverse={node.direction === "out"}
          duration={3.4}
          delay={i * 0.45}
        />
      ))}
    </div>
  );
}
