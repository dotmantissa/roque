#!/usr/bin/env python3
"""Generate the branded Roque backend and contract architecture PDF."""

from __future__ import annotations

import html
import json
import subprocess
from datetime import date
from pathlib import Path
from typing import Iterable

from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents


ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).with_name("Roque-Technical-Architecture.pdf")
DEPLOYMENT = json.loads((ROOT / "packages/shared/src/deployment.json").read_text())
GL_DEPLOYMENT = json.loads((ROOT / "packages/genlayer/deployment.json").read_text())

try:
    COMMIT = subprocess.check_output(
        ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True
    ).strip()
except Exception:
    COMMIT = "unknown"

DOC_DATE = date.today().strftime("%B %d, %Y")

INK = HexColor("#26292c")
DARK = HexColor("#17191b")
BLUE = HexColor("#003dad")
BRIGHT_BLUE = HexColor("#2f6bff")
PALE_BLUE = HexColor("#eaf0ff")
SURFACE = HexColor("#f6f7f9")
MUTED = HexColor("#66707b")
BORDER = HexColor("#d9dde3")
GREEN = HexColor("#0a7d4f")
PALE_GREEN = HexColor("#e8f5ef")
RED = HexColor("#b53229")
PALE_RED = HexColor("#faecea")
AMBER = HexColor("#9b6100")
PALE_AMBER = HexColor("#fff5df")
WHITE = colors.white

PAGE_W, PAGE_H = A4
LEFT = 18 * mm
RIGHT = 18 * mm
TOP = 18 * mm
BOTTOM = 17 * mm
CONTENT_W = PAGE_W - LEFT - RIGHT


def register_fonts() -> None:
    font_dir = Path("/usr/share/fonts/truetype/ubuntu")
    pdfmetrics.registerFont(TTFont("Ubuntu", str(font_dir / "Ubuntu-R.ttf")))
    pdfmetrics.registerFont(TTFont("Ubuntu-Bold", str(font_dir / "Ubuntu-B.ttf")))
    pdfmetrics.registerFont(TTFont("Ubuntu-Light", str(font_dir / "Ubuntu-L.ttf")))
    pdfmetrics.registerFont(TTFont("UbuntuMono", str(font_dir / "UbuntuMono-R.ttf")))
    pdfmetrics.registerFont(TTFont("UbuntuMono-Bold", str(font_dir / "UbuntuMono-B.ttf")))


register_fonts()


def esc(value: object) -> str:
    return html.escape(str(value), quote=False)


def code(value: object) -> str:
    return f'<font name="UbuntuMono" color="#003dad">{esc(value)}</font>'


def bold(value: object) -> str:
    return f"<b>{esc(value)}</b>"


base = getSampleStyleSheet()
STYLES = {
    "CoverKicker": ParagraphStyle(
        "CoverKicker",
        parent=base["Normal"],
        fontName="UbuntuMono-Bold",
        fontSize=9,
        leading=12,
        textColor=HexColor("#8eaeff"),
        spaceAfter=6,
    ),
    "CoverTitle": ParagraphStyle(
        "CoverTitle",
        parent=base["Title"],
        fontName="Ubuntu-Bold",
        fontSize=31,
        leading=34,
        textColor=WHITE,
        alignment=TA_LEFT,
        spaceAfter=9,
    ),
    "CoverSub": ParagraphStyle(
        "CoverSub",
        parent=base["Normal"],
        fontName="Ubuntu-Light",
        fontSize=13,
        leading=19,
        textColor=HexColor("#cbd3df"),
        spaceAfter=16,
    ),
    "Heading1": ParagraphStyle(
        "Heading1",
        parent=base["Heading1"],
        fontName="Ubuntu-Bold",
        fontSize=19,
        leading=23,
        textColor=INK,
        spaceBefore=6,
        spaceAfter=8,
        keepWithNext=True,
    ),
    "Heading2": ParagraphStyle(
        "Heading2",
        parent=base["Heading2"],
        fontName="Ubuntu-Bold",
        fontSize=13,
        leading=17,
        textColor=BLUE,
        spaceBefore=8,
        spaceAfter=5,
        keepWithNext=True,
    ),
    "Heading3": ParagraphStyle(
        "Heading3",
        parent=base["Heading3"],
        fontName="Ubuntu-Bold",
        fontSize=10.5,
        leading=14,
        textColor=INK,
        spaceBefore=6,
        spaceAfter=4,
        keepWithNext=True,
    ),
    "Body": ParagraphStyle(
        "Body",
        parent=base["BodyText"],
        fontName="Ubuntu",
        fontSize=8.7,
        leading=13,
        textColor=INK,
        spaceAfter=5,
    ),
    "Small": ParagraphStyle(
        "Small",
        parent=base["BodyText"],
        fontName="Ubuntu",
        fontSize=7.4,
        leading=10.5,
        textColor=MUTED,
        spaceAfter=3,
    ),
    "MonoSmall": ParagraphStyle(
        "MonoSmall",
        parent=base["BodyText"],
        fontName="UbuntuMono",
        fontSize=6.8,
        leading=9.5,
        textColor=INK,
    ),
    "Bullet": ParagraphStyle(
        "Bullet",
        parent=base["BodyText"],
        fontName="Ubuntu",
        fontSize=8.5,
        leading=12.5,
        leftIndent=10,
        firstLineIndent=-7,
        bulletIndent=0,
        textColor=INK,
        spaceAfter=3,
    ),
    "Number": ParagraphStyle(
        "Number",
        parent=base["BodyText"],
        fontName="Ubuntu",
        fontSize=8.5,
        leading=12.5,
        leftIndent=14,
        firstLineIndent=-11,
        bulletIndent=0,
        textColor=INK,
        spaceAfter=4,
    ),
    "CalloutTitle": ParagraphStyle(
        "CalloutTitle",
        parent=base["Normal"],
        fontName="Ubuntu-Bold",
        fontSize=8.5,
        leading=11,
        textColor=INK,
        spaceAfter=2,
    ),
    "CalloutBody": ParagraphStyle(
        "CalloutBody",
        parent=base["BodyText"],
        fontName="Ubuntu",
        fontSize=8,
        leading=11.5,
        textColor=INK,
    ),
    "TableHead": ParagraphStyle(
        "TableHead",
        parent=base["Normal"],
        fontName="Ubuntu-Bold",
        fontSize=7.3,
        leading=9.5,
        textColor=WHITE,
    ),
    "TableCell": ParagraphStyle(
        "TableCell",
        parent=base["Normal"],
        fontName="Ubuntu",
        fontSize=7.2,
        leading=10,
        textColor=INK,
    ),
    "TableCellSmall": ParagraphStyle(
        "TableCellSmall",
        parent=base["Normal"],
        fontName="Ubuntu",
        fontSize=6.5,
        leading=8.7,
        textColor=INK,
    ),
    "TableMono": ParagraphStyle(
        "TableMono",
        parent=base["Normal"],
        fontName="UbuntuMono",
        fontSize=6.2,
        leading=8.5,
        textColor=INK,
    ),
    "Quote": ParagraphStyle(
        "Quote",
        parent=base["BodyText"],
        fontName="Ubuntu-Bold",
        fontSize=11,
        leading=16,
        leftIndent=12,
        rightIndent=12,
        textColor=BLUE,
        alignment=TA_CENTER,
        spaceBefore=7,
        spaceAfter=9,
    ),
    "TOCHeading": ParagraphStyle(
        "TOCHeading",
        parent=base["Heading1"],
        fontName="Ubuntu-Bold",
        fontSize=20,
        leading=24,
        textColor=INK,
        spaceAfter=12,
    ),
}


class RoqueDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str):
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=LEFT,
            rightMargin=RIGHT,
            topMargin=TOP,
            bottomMargin=BOTTOM,
            title="Roque Technical Architecture",
            author="Roque",
            subject="Backend, intelligent contract, autonomous execution, and Solidity architecture",
        )
        body_frame = Frame(
            LEFT,
            BOTTOM,
            CONTENT_W,
            PAGE_H - TOP - BOTTOM,
            id="body",
            leftPadding=0,
            rightPadding=0,
            topPadding=7 * mm,
            bottomPadding=5 * mm,
        )
        cover_frame = Frame(
            LEFT,
            BOTTOM,
            CONTENT_W,
            PAGE_H - TOP - BOTTOM,
            id="cover",
            leftPadding=0,
            rightPadding=0,
            topPadding=34 * mm,
            bottomPadding=10 * mm,
        )
        self.addPageTemplates(
            [
                PageTemplate(id="cover", frames=[cover_frame], onPage=draw_cover),
                PageTemplate(id="body", frames=[body_frame], onPage=draw_body_page),
            ]
        )

    def afterFlowable(self, flowable: Flowable) -> None:
        if not isinstance(flowable, Paragraph):
            return
        style_name = flowable.style.name
        if style_name not in ("Heading1", "Heading2"):
            return
        level = 0 if style_name == "Heading1" else 1
        text = flowable.getPlainText()
        key = f"heading-{self.seq.nextf('heading')}"
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(text, key, level=level, closed=False)
        self.notify("TOCEntry", (level, text, self.page, key))


def draw_rook(canvas, x: float, y: float, size: float, color=BRIGHT_BLUE) -> None:
    canvas.saveState()
    canvas.setFillColor(color)
    unit = size / 32
    # A compact geometric version of the Roque rook mark.
    canvas.rect(x + 7 * unit, y + 4 * unit, 3.4 * unit, 7.2 * unit, fill=1, stroke=0)
    canvas.rect(x + 14.3 * unit, y + 4 * unit, 3.4 * unit, 7.2 * unit, fill=1, stroke=0)
    canvas.rect(x + 21.6 * unit, y + 4 * unit, 3.4 * unit, 7.2 * unit, fill=1, stroke=0)
    canvas.rect(x + 7 * unit, y + 8.4 * unit, 18 * unit, 3.2 * unit, fill=1, stroke=0)
    canvas.rect(x + 9.6 * unit, y + 11 * unit, 12.8 * unit, 10.3 * unit, fill=1, stroke=0)
    canvas.rect(x + 7 * unit, y + 22.2 * unit, 18 * unit, 5.8 * unit, fill=1, stroke=0)
    canvas.setFillColor(DARK)
    canvas.setFillAlpha(0.34)
    canvas.rect(x + 15 * unit, y + 14.6 * unit, 2 * unit, 9.2 * unit, fill=1, stroke=0)
    canvas.restoreState()


def draw_cover(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFillColor(DARK)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setStrokeColor(HexColor("#242a31"))
    canvas.setLineWidth(0.35)
    gap = 13 * mm
    x = 0
    while x < PAGE_W:
        canvas.line(x, 0, x, PAGE_H)
        x += gap
    y = 0
    while y < PAGE_H:
        canvas.line(0, y, PAGE_W, y)
        y += gap
    canvas.setFillColor(BLUE)
    canvas.rect(0, 0, 7 * mm, PAGE_H, fill=1, stroke=0)
    draw_rook(canvas, LEFT, PAGE_H - 48 * mm, 24 * mm, BRIGHT_BLUE)
    canvas.setFont("Ubuntu-Bold", 14)
    canvas.setFillColor(WHITE)
    canvas.drawString(LEFT + 29 * mm, PAGE_H - 35 * mm, "Roque")
    canvas.setFont("UbuntuMono", 7)
    canvas.setFillColor(HexColor("#91a0b3"))
    canvas.drawRightString(
        PAGE_W - RIGHT,
        16 * mm,
        f"Architecture snapshot {COMMIT}  |  {DOC_DATE}",
    )
    canvas.restoreState()


def draw_body_page(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFillColor(WHITE)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(LEFT, PAGE_H - 12 * mm, PAGE_W - RIGHT, PAGE_H - 12 * mm)
    draw_rook(canvas, LEFT, PAGE_H - 10.2 * mm, 5.5 * mm, BLUE)
    canvas.setFont("Ubuntu-Bold", 7.5)
    canvas.setFillColor(INK)
    canvas.drawString(LEFT + 7.2 * mm, PAGE_H - 8.7 * mm, "Roque Technical Architecture")
    canvas.setFont("UbuntuMono", 6.5)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(PAGE_W - RIGHT, PAGE_H - 8.7 * mm, f"snapshot {COMMIT}")
    canvas.line(LEFT, 11 * mm, PAGE_W - RIGHT, 11 * mm)
    canvas.setFont("Ubuntu", 6.5)
    canvas.drawString(LEFT, 7 * mm, "Backend, GenLayer, autonomous execution, contracts, Latch")
    canvas.drawRightString(PAGE_W - RIGHT, 7 * mm, f"{doc.page}")
    canvas.restoreState()


def P(text: str, style: str = "Body") -> Paragraph:
    return Paragraph(text, STYLES[style])


def H(text: str, level: int = 1) -> Paragraph:
    return Paragraph(text, STYLES[f"Heading{level}"])


def bullets(items: Iterable[str]) -> list[Flowable]:
    return [Paragraph(f"- {item}", STYLES["Bullet"]) for item in items]


def numbers(items: Iterable[str]) -> list[Flowable]:
    return [
        Paragraph(f"{idx}. {item}", STYLES["Number"])
        for idx, item in enumerate(items, start=1)
    ]


def callout(title: str, body: str, kind: str = "info") -> Table:
    palette = {
        "info": (PALE_BLUE, BLUE),
        "safe": (PALE_GREEN, GREEN),
        "warn": (PALE_AMBER, AMBER),
        "risk": (PALE_RED, RED),
    }
    bg, line = palette[kind]
    content = [
        P(title, "CalloutTitle"),
        P(body, "CalloutBody"),
    ]
    table = Table([[content]], colWidths=[CONTENT_W - 1 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), bg),
                ("BOX", (0, 0), (-1, -1), 0.7, line),
                ("LINEBEFORE", (0, 0), (0, -1), 3.5, line),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    return table


def data_table(
    headers: list[str],
    rows: list[list[object]],
    widths: list[float] | None = None,
    small: bool = False,
) -> Table:
    cell_style = STYLES["TableCellSmall" if small else "TableCell"]
    cooked = [[P(h, "TableHead") for h in headers]]
    for row in rows:
        cooked.append(
            [
                value
                if isinstance(value, Flowable)
                else Paragraph(str(value), cell_style)
                for value in row
            ]
        )
    table = Table(cooked, colWidths=widths, repeatRows=1, hAlign="LEFT")
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.35, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    for idx in range(1, len(cooked)):
        if idx % 2 == 0:
            commands.append(("BACKGROUND", (0, idx), (-1, idx), SURFACE))
    table.setStyle(TableStyle(commands))
    return table


def flow_strip(stages: list[tuple[str, str, str]]) -> Table:
    cells = []
    for label, title, body in stages:
        content = [
            P(label.upper(), "CoverKicker"),
            P(f"<b>{esc(title)}</b>", "CalloutTitle"),
            P(body, "Small"),
        ]
        cells.append(content)
    widths = [CONTENT_W / len(cells)] * len(cells)
    table = Table([cells], colWidths=widths, hAlign="LEFT")
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.6, BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.6, BORDER),
        ("BACKGROUND", (0, 0), (-1, -1), SURFACE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]
    table.setStyle(TableStyle(style))
    return table


def architecture_stack() -> Table:
    rows = [
        [
            P("JUDGMENT", "TableHead"),
            P("<b>GenLayer intelligent contract</b><br/>Natural language -> normalized intent. "
              "Validator consensus handles the non-deterministic LLM call. Holds no funds.", "TableCell"),
        ],
        [
            P("COORDINATION", "TableHead"),
            P("<b>Shared TypeScript core + relayer</b><br/>Persists requests, reads the finalized "
              "interpretation, quotes Sepolia, constructs typed intents, signs as the agent, and "
              "broadcasts transactions.", "TableCell"),
        ],
        [
            P("AUTHORIZATION", "TableHead"),
            P("<b>AgentExecutor on Sepolia</b><br/>Recovers the agent signature and enforces the "
              "user's capability, nonce, deadline, Chainlink USD caps, slippage, and vault balance.", "TableCell"),
        ],
        [
            P("EXECUTION", "TableHead"),
            P("<b>DEXRouter, LiquidityPool, OrderBook</b><br/>Deterministic AMM settlement and "
              "oracle-gated resting orders. Events become the canonical settlement record.", "TableCell"),
        ],
        [
            P("GOVERNANCE", "TableHead"),
            P("<b>Latch on relayer writes</b><br/>Optional RPC credential proxy and policy/audit "
              "boundary between locally signed relayer traffic and the upstream Sepolia RPC.", "TableCell"),
        ],
    ]
    table = Table(rows, colWidths=[35 * mm, CONTENT_W - 35 * mm], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), BLUE),
                ("TEXTCOLOR", (0, 0), (0, -1), WHITE),
                ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ("BACKGROUND", (1, 0), (1, -1), SURFACE),
            ]
        )
    )
    return table


def add_sequence(
    story: list[Flowable],
    title: str,
    rows: list[list[str]],
) -> None:
    story.append(H(title, 3))
    story.append(
        data_table(
            ["#", "Actor / boundary", "Technical action", "State produced"],
            rows,
            [9 * mm, 35 * mm, 88 * mm, CONTENT_W - 132 * mm],
            small=True,
        )
    )
    story.append(Spacer(1, 4))


story: list[Flowable] = []

# Cover
story.extend(
    [
        NextPageTemplate("body"),
        P("TECHNICAL ARCHITECTURE", "CoverKicker"),
        P("From Natural-Language Trade<br/>to On-Chain Settlement", "CoverTitle"),
        P(
            "A code-level explanation of Roque's backend, GenLayer judgment layer, "
            "autonomous capability model, Latch boundary, keeper/indexer services, "
            "and Solidity execution contracts.",
            "CoverSub",
        ),
        Spacer(1, 8 * mm),
        flow_strip(
            [
                ("01", "Interpret", "Validators convert a user's words into a constrained exact-input intent."),
                ("02", "Authorize", "A user signature defines the agent's bounded capability."),
                ("03", "Execute", "Sepolia contracts decide whether value can move and settle the trade."),
            ]
        ),
        Spacer(1, 15 * mm),
        P(
            "Core invariant",
            "CoverKicker",
        ),
        P(
            "The intelligent layer may propose and coordinate. It cannot bypass deterministic authorization.",
            "Quote",
        ),
        Spacer(1, 15 * mm),
        P(
            f"Repository: {code('dotmantissa/roque')}<br/>"
            f"Snapshot commit: {code(COMMIT)}<br/>"
            f"Generated: {esc(DOC_DATE)}<br/>"
            f"Primary network: Ethereum Sepolia ({DEPLOYMENT['chainId']})<br/>"
            f"GenLayer network: {esc(GL_DEPLOYMENT['network'])}",
            "CoverSub",
        ),
        PageBreak(),
    ]
)

# Contents
story.append(P("Contents", "TOCHeading"))
toc = TableOfContents()
toc.levelStyles = [
    ParagraphStyle(
        "TOC1",
        fontName="Ubuntu-Bold",
        fontSize=9,
        leading=13,
        leftIndent=0,
        firstLineIndent=0,
        textColor=INK,
        spaceBefore=3,
    ),
    ParagraphStyle(
        "TOC2",
        fontName="Ubuntu",
        fontSize=8,
        leading=11,
        leftIndent=12,
        firstLineIndent=0,
        textColor=MUTED,
    ),
]
story.append(toc)
story.append(PageBreak())

# 1
story.append(H("1. Executive Summary"))
story.append(
    P(
        "Roque is an agent-native decentralized exchange demo that deliberately separates "
        "language understanding from financial authority. The user's command is interpreted "
        "by a GenLayer intelligent contract, coordinated by a shared TypeScript backend, and "
        "ultimately accepted or rejected by deterministic Solidity contracts on Ethereum "
        "Sepolia. The result is a system where an AI-assisted path can be expressive without "
        "making the model, the database, the relayer, or the keeper the final authority over funds."
    )
)
story.append(architecture_stack())
story.append(Spacer(1, 7))
story.append(
    callout(
        "What the shipped system actually guarantees",
        "Autonomous actions can draw only from balances explicitly deposited into the "
        "AgentExecutor vault. Every action must carry a valid agent EIP-712 signature and "
        "survive on-chain checks for registered tokens, capability status, capability expiry, "
        "intent deadline, nonce reuse, Chainlink-valued per-trade and daily limits, slippage, "
        "and vault sufficiency.",
        "safe",
    )
)
story.append(Spacer(1, 6))
story.append(
    callout(
        "What this document does not claim",
        "The current code does not implement a per-user token allowlist, action bitmap, "
        "rolling 24-hour window, Latch-managed signing key, or trustless GenLayer-to-Sepolia "
        "bridge. The older ARCHITECTURE.md describes several of those as planned features. "
        "This document follows the current code and deployment metadata instead.",
        "warn",
    )
)
story.append(H("1.1 User-visible outcome", 2))
story.extend(
    bullets(
        [
            "In copilot mode, Roque interprets and prepares the transaction, but the user's connected wallet approves and sends every on-chain action.",
            "In autonomous confirm mode, the user reviews the interpreted card and then asks the backend agent to act under an existing capability.",
            "In autonomous direct mode, a valid interpretation is passed to the agent execution path immediately, without a second UI confirmation.",
            "Market swaps settle against one of 45 direct constant-product pools. Limit orders escrow input in the OrderBook and settle later when the ETH/USD trigger is true.",
            "The activity layer reconstructs requests from Neon and settlement from Sepolia events; Sepolia remains the financial source of truth.",
        ]
    )
)

# 2
story.append(H("2. Scope, Sources, and Current Snapshot"))
story.append(
    P(
        "The repository contains an early architecture plan, a newer README, current source code, "
        "deployment artifacts, and tests. Where they conflict, this analysis prioritizes executable "
        "source and the deployment JSON consumed by the running application."
    )
)
story.append(
    data_table(
        ["Priority", "Source", "How it is used"],
        [
            ["1", code("contracts/src/*"), "Authoritative financial behavior and enforcement."],
            ["2", code("packages/core/src/*"), "Authoritative backend orchestration, signing, persistence, workers, and RPC behavior."],
            ["3", code("packages/genlayer/contracts/roque_interpreter.py"), "Authoritative natural-language interpretation and deterministic normalization."],
            ["4", code("packages/shared/src/deployment.json"), "Current addresses, token registry, feeds, and complete pool mesh."],
            ["5", "Tests", "Evidence for intended invariants and rejection paths."],
            ["6", code("README.md / ARCHITECTURE.md"), "Context and original intent; some deployment and feature statements are stale."],
        ],
        [12 * mm, 58 * mm, CONTENT_W - 70 * mm],
    )
)
story.append(H("2.1 Current deployment endpoints", 2))
story.append(
    data_table(
        ["Component", "Network", "Address"],
        [
            ["DEXRouter", "Sepolia", code(DEPLOYMENT["router"])],
            ["OrderBook", "Sepolia", code(DEPLOYMENT["orderBook"])],
            ["AgentExecutor", "Sepolia", code(DEPLOYMENT["agentExecutor"])],
            ["FaucetRouter", "Sepolia", code(DEPLOYMENT["faucetRouter"])],
            ["Configured agent signer", "Sepolia EOA", code(DEPLOYMENT["agentSigner"])],
            ["ETH/USD trigger feed", "Sepolia Chainlink", code(DEPLOYMENT["priceFeed"])],
            ["RoqueInterpreter", GL_DEPLOYMENT["network"], code(GL_DEPLOYMENT["address"])],
        ],
        [43 * mm, 36 * mm, CONTENT_W - 79 * mm],
        small=True,
    )
)
story.append(
    callout(
        "Snapshot warning",
        "The addresses above come from the files imported by the running application at commit "
        f"{COMMIT}. The addresses printed in the top-level README are from an older deployment.",
        "warn",
    )
)
story.append(H("2.2 Repository topology", 2))
story.append(
    data_table(
        ["Area", "Responsibility"],
        [
            [code("apps/web"), "Next.js UI plus thin server routes over the shared core. Frontend detail is intentionally minimized here."],
            [code("apps/relayer"), "Fastify transport and long-lived keeper/indexer loops."],
            [code("packages/core"), "Single backend implementation shared by Next.js routes and the standalone relayer."],
            [code("packages/shared"), "ABIs, addresses, token/pool metadata, and EIP-712 domain/type definitions."],
            [code("packages/genlayer"), "Python intelligent contract, local runtime shim, tests, and deployment record."],
            [code("contracts"), "Foundry project for token, AMM, router, order book, executor, faucet helper, deployment, and tests."],
        ],
        [43 * mm, CONTENT_W - 43 * mm],
    )
)

# 3
story.append(H("3. System Architecture and Trust Boundaries"))
story.append(
    P(
        "Roque is best understood as five cooperating planes. Each plane owns a different "
        "kind of truth, and the design is safest when those responsibilities do not collapse "
        "into one service."
    )
)
story.append(
    data_table(
        ["Plane", "Owns", "Does not own"],
        [
            ["Judgment", "Semantic interpretation and optional subjective adjudication.", "Funds, permissions, or execution finality."],
            ["Coordination", "Request lifecycle, quoting, typed-intent construction, signatures, broadcast.", "Authority to exceed a user's on-chain capability."],
            ["Authorization", "Vault balances, capability, nonces, USD accounting, slippage policy.", "Natural-language meaning."],
            ["Execution", "AMM reserve math, escrowed orders, trigger checks, token transfers.", "Agent intent or business preference."],
            ["Governance / audit", "Latch proxy policy and activity; Neon request/trade notebook.", "Canonical balances or settlement state."],
        ],
        [31 * mm, 67 * mm, CONTENT_W - 98 * mm],
    )
)
story.append(H("3.1 Data ownership", 2))
story.append(
    data_table(
        ["Store / system", "Canonical data"],
        [
            ["Ethereum Sepolia", "Token balances, pool reserves, approvals, vault balances, capabilities, nonces, daily spend, orders, fills, cancellations, and emitted settlement events."],
            ["GenLayer", "Interpretation and adjudication JSON keyed by request id after validator consensus."],
            ["Neon Postgres", "Natural-language request audit trail, cached interpretation, transaction hash, event-derived trade history, and indexer bookmark."],
            ["Latch", "External upstream secret, scoped latch token, configured request/response policy, and allowed/denied activity trace."],
            ["Server environment", "Agent signer private key, relayer gas-payer private key, database URL, GenLayer/RPC endpoints, and optional Latch token."],
            ["Browser local storage", "Conversation display state and autonomous confirm/direct preference; never canonical financial state."],
        ],
        [40 * mm, CONTENT_W - 40 * mm],
    )
)
story.append(H("3.2 Network call graph", 2))
story.append(
    flow_strip(
        [
            ("A", "Browser / API", "POST /interpret with command, mode, and optional user address."),
            ("B", "Core service", "Neon insert, Chainlink context read, GenLayer write/wait/read."),
            ("C", "Decision branch", "Copilot returns data for a user signature; autonomous constructs an agent-signed intent."),
            ("D", "Sepolia", "Executor/router/order book/pool enforce and settle."),
        ]
    )
)
story.append(Spacer(1, 5))
story.append(
    callout(
        "No trustless bridge",
        "GenLayer does not send a Sepolia transaction in this implementation. The backend waits "
        "for the GenLayer result, reads it, stores it in Neon, and later constructs a separate "
        "Sepolia transaction. The database and relayer are therefore coordination dependencies, "
        "but the AgentExecutor still bounds what their output can do.",
        "info",
    )
)

# 4
story.append(H("4. Natural-Language Trade Lifecycle"))
story.append(
    P(
        "This section follows a command from ingress through a structured, quoted intent. "
        "The execution branch is covered separately for copilot and autonomous mode."
    )
)
add_sequence(
    story,
    "4.1 Request ingress and audit record",
    [
        ["1", code("POST /api/interpret"), "The browser submits command, mode, and optional user address.", "Untrusted HTTP body."],
        ["2", code("handleInterpret"), "Zod enforces a 1-500 character command, mode in copilot/autonomous, and Ethereum-address shape.", "Validated input or HTTP 400."],
        ["3", code("interpretCommand"), "A UUID is generated and inserted into Neon with status interpreting.", "Durable request id and original command."],
        ["4", code("buildContext"), "The backend reads ETH/USD and includes the canonical token symbol list. Price failure is tolerated.", "Small hint object; never permission."],
    ],
)
story.append(
    P(
        "The database write occurs before the model call. This preserves the exact user command "
        "even when GenLayer fails. Neon is described in the source as the agent's notebook, not "
        "its wallet: chain state always wins for balances, orders, and authorization."
    )
)
add_sequence(
    story,
    "4.2 GenLayer invocation and consensus",
    [
        ["5", code("core/genlayer.interpret"), "A throwaway GenLayer account submits a write to RoqueInterpreter.interpret(requestId, command, contextJson).", "GenLayer transaction hash."],
        ["6", "Retry wrapper", "Transient fetch, timeout, socket, and network errors are retried up to four attempts.", "Either a submitted write or a backend failure."],
        ["7", "Receipt wait", "The client waits with 30 retries at four-second intervals.", "Finalized/accepted GenLayer result for this client flow."],
        ["8", code("get_interpretation"), "A view call reads the JSON stored under the request id.", "Raw JSON string parsed into Interpretation."],
    ],
)
story.append(H("4.3 What the intelligent contract asks the model to produce", 2))
story.append(
    data_table(
        ["Field", "Meaning"],
        [
            [code("kind"), "swap, limit, or unknown."],
            [code("tokenIn / tokenOut"), "What the user spends and receives, normalized to one of ten Roque symbols."],
            [code("amount"), "Decimal string. The execution engine supports exact-input amounts only."],
            [code("amountToken"), "Model annotation identifying whether the amount describes input or desired output."],
            [code("amountIsPercent"), "Whether amount is a percentage of the relevant input balance."],
            [code("triggerPrice / triggerAbove"), "ETH/USD threshold and direction for resting orders."],
            [code("confidence / reason"), "Display metadata; not an authorization input."],
        ],
        [42 * mm, CONTENT_W - 42 * mm],
    )
)
story.append(H("4.4 Deterministic normalization inside GenLayer", 2))
story.extend(
    numbers(
        [
            "Strip model prose or code fences and extract the first usable JSON object.",
            "Require kind to be swap or limit; otherwise return a structured rejection.",
            "Map loose aliases such as ETH, ether, BTC, dollars, euro, and gold to canonical r-prefixed symbols.",
            "Reject unknown tokens, same-token trades, missing amounts, non-decimal amounts, and zero.",
            "Require percentages to satisfy 0 < percent <= 100 without floating-point arithmetic.",
            "Reject exact-output requests. If the user fixes the amount to receive, the interpreter asks them to restate how much input to spend.",
            "Permit limit orders only when rWETH is one side, because the OrderBook watches one ETH/USD feed.",
            "Require a positive trigger price for a limit order.",
            "Derive buy/sell/swap from stablecoin direction instead of trusting the model's action label.",
            "Return sorted JSON so validator comparison operates on normalized structure instead of prose.",
        ]
    )
)
story.append(
    callout(
        "Consensus mechanism",
        "The interpreter wraps the LLM work in GenLayer prompt_comparative. Validators independently "
        "produce normalized intents and accept equivalence only when kind, pair, amount, percentage "
        "flag, trigger direction, and trigger price (within one percent) agree. A malformed consensus "
        "blob becomes a low-confidence rejection.",
        "info",
    )
)
story.append(H("4.5 Backend validation, persistence, and quote", 2))
story.extend(
    numbers(
        [
            "The backend parses the stored JSON. Non-JSON or absent data becomes a refusal object.",
            "A rejected interpretation is written to Neon with status rejected, reason, error, and full JSON.",
            "The backend independently resolves token symbols from the shared deployment registry. An unknown symbol is rejected again even if GenLayer marked it valid.",
            "A valid interpretation is persisted with status ready and all structured fields.",
            "For a non-percentage amount, the backend attempts a current on-chain quote through DEXRouter.quoteSwap and computes display notional from Chainlink.",
            "Quote failure does not invalidate interpretation. The actual prepare/execute step quotes again and fails explicitly if the pool cannot serve the trade.",
        ]
    )
)
story.append(
    P(
        "The quote path is deterministic: human units are converted with the input token's decimals, "
        "the router locates the pair's single pool, and LiquidityPool.getAmountOut applies the "
        "constant-product formula with the pool's 30 basis-point fee."
    )
)

# 5
story.append(H("5. Copilot Execution Path"))
story.append(
    P(
        "Copilot is the non-delegated path. The backend interprets and prepares, but the user wallet "
        "is the transaction sender. No capability, agent signature, AgentExecutor vault, or Latch "
        "relayer path is required."
    )
)
story.append(H("5.1 Copilot market swap", 2))
add_sequence(
    story,
    "Exact call sequence",
    [
        ["1", "Backend", "prepareCopilotSwap re-quotes the exact input and computes minAmountOut from the selected slippage basis points.", "Router address and raw call arguments."],
        ["2", "User wallet", "If allowance is below amountIn, approve the router. The helper requests the exact amount, not unlimited approval.", "ERC-20 allowance."],
        ["3", "User wallet", "Call DEXRouter.swapExactTokensForTokens with a ten-minute deadline and the user as recipient.", "Wallet-signed Sepolia transaction."],
        ["4", "DEXRouter", "Pull tokenIn from the user, approve the selected pool, and invoke LiquidityPool.swap.", "Input reaches the AMM."],
        ["5", "LiquidityPool", "Calculate output, enforce minAmountOut, transfer output to the user, and sync reserves.", "Settled balances and Swapped event."],
        ["6", "Browser/backend", "The browser waits for the receipt, then reports the tx hash to /swap/confirm.", "Intent status submitted; indexer later records RouterSwap."],
    ],
)
story.append(H("5.2 Copilot limit order", 2))
story.extend(
    numbers(
        [
            "Percentage commands are resolved against the connected wallet balance.",
            "The browser computes a trigger-aware output floor: each leg is valued in USD, the rWETH leg uses the trigger price, the other leg uses the current token oracle, then the selected slippage is applied.",
            "The user approves the OrderBook for the exact input amount and calls createOrder.",
            "OrderBook transfers the input into escrow, records owner/pair/amount/minOut/trigger/expiry/status, and emits OrderCreated.",
            "The order expires after seven days by default. Expiry blocks fills but does not automatically return escrow; the user must cancel.",
        ]
    )
)
story.append(
    callout(
        "Frontend boundary only",
        "The frontend's important architectural role is choosing which wallet signs. Copilot contract "
        "calls originate from the user; autonomous contract calls originate from the relayer and carry "
        "a separate agent signature inside calldata.",
        "info",
    )
)

# 6
story.append(H("6. Autonomous Mode in Depth"))
story.append(
    P(
        "Autonomous mode changes authorization, funding, signing, gas payment, and output custody. "
        "It does not change the AMM or order-trigger contracts. The mode is built from two durable "
        "on-chain primitives: an isolated user vault and a revocable capability naming one agent signer."
    )
)
story.append(H("6.1 Prerequisites: vault funding", 2))
story.extend(
    numbers(
        [
            "The user selects a token and amount in token or USD terms.",
            "The wallet approves AgentExecutor for the exact raw token amount if required.",
            "The wallet calls AgentExecutor.deposit(token, amount).",
            "AgentExecutor pulls the tokens and increments vaultBalance[user][token].",
            "Only the user can call withdraw. Autonomous swaps can transform balances inside the vault, but the agent cannot deposit more from the wallet or withdraw to an arbitrary destination.",
        ]
    )
)
story.append(
    callout(
        "Isolation property",
        "A capability alone is insufficient. An empty vault causes autonomous execution to revert. "
        "Conversely, vault funds without a live capability cannot be spent by the agent.",
        "safe",
    )
)
story.append(H("6.2 Capability grant and the first signature", 2))
story.append(
    P(
        "The user signs an EIP-712 Grant off-chain. The shared domain is name "
        f"{code('RoqueAgentExecutor')}, version {code('1')}, chain id "
        f"{code(DEPLOYMENT['chainId'])}, verifying contract {code(DEPLOYMENT['agentExecutor'])}."
    )
)
story.append(
    data_table(
        ["Grant field", "Enforced meaning"],
        [
            [code("user"), "The wallet whose vault and capability are affected."],
            [code("agentSigner"), "The only address whose per-action EIP-712 signatures are accepted."],
            [code("maxPerTradeUsd"), "Maximum input notional for one autonomous action, 1e18 USD fixed point."],
            [code("maxDailyUsd"), "Maximum input notional booked in one block.timestamp / 1 days bucket."],
            [code("maxSlippageBps"), "How far minAmountOut may sit below the executor's current router quote."],
            [code("validUntil"), "Unix timestamp after which all new agent actions revert."],
            [code("grantNonce"), "On-chain counter preventing replay of an older signed grant."],
        ],
        [43 * mm, CONTENT_W - 43 * mm],
    )
)
story.extend(
    numbers(
        [
            "The browser reads grantNonce and signs the exact typed message.",
            "The signed values are sent to POST /grant.",
            "The relayer pays gas and calls grantCapabilityWithSig.",
            "AgentExecutor recomputes the typed-data digest using the current nonce and recovers the user address.",
            "On success, grantNonce increments and the capability mapping is overwritten with the new limits and revoked=false.",
        ]
    )
)
story.append(
    callout(
        "Gas sponsorship does not create authority",
        "The relayer can submit the grant transaction, but it cannot fabricate the user's EIP-712 "
        "signature. A mismatched field changes the digest and fails recovery.",
        "safe",
    )
)
story.append(H("6.3 Confirm versus direct autonomous execution", 2))
story.append(
    data_table(
        ["Mode", "When POST /execute is called", "Cryptographic difference"],
        [
            ["Confirm", "After interpretation, when the user clicks the action on the structured intent card.", "None. The click is UX confirmation, not an additional wallet signature."],
            ["Direct", "Immediately after a valid interpretation if the client sees a live capability.", "None. The same backend endpoint, agent key, and executor checks are used."],
        ],
        [27 * mm, 78 * mm, CONTENT_W - 105 * mm],
    )
)
story.append(
    callout(
        "Critical distinction",
        "Once the capability exists, the security boundary is the capability and vault, not the "
        "confirm-mode click. Direct mode removes the final human review but does not widen the "
        "on-chain box.",
        "warn",
    )
)
story.append(H("6.4 Backend autonomous execution", 2))
add_sequence(
    story,
    "From ready intent to signed transaction",
    [
        ["1", code("POST /execute"), "Validate intent id, user address, and requested slippage (0-5000 bps).", "Typed request."],
        ["2", "Neon", "Load the intent row by id and read its stored interpretation JSON.", "Candidate action."],
        ["3", "Shared registry", "Resolve both symbols to deployed token metadata.", "Addresses and decimals."],
        ["4", "AgentExecutor read", "Require a capability that exists, is not revoked, and names the server's agent signer.", "Friendly pre-check."],
        ["5", "Amount resolver", "Absolute amount passes through. Percentage amount is calculated from the user's input-token vault balance.", "Concrete exact input."],
        ["6", "Vault read", "Refuse early when balance is below amountIn.", "Friendly pre-check."],
        ["7", "Router quote", "Quote current output and set minOut using min(requested slippage, capability max slippage).", "Execution floor."],
        ["8", "Nonce/deadline", "Choose a millisecond timestamp nonce verified unused; set a five-minute intent deadline.", "Replay and staleness controls."],
        ["9", "Agent signer", "Sign SwapIntent or LimitIntent using AGENT_SIGNER_PRIVATE_KEY.", "Per-action EIP-712 signature."],
        ["10", "Relayer wallet", "Encode executeSwap or createLimitOrder and broadcast to AgentExecutor.", "Sepolia tx hash returned immediately."],
    ],
)
story.append(
    callout(
        "Broadcast versus confirmation",
        "submitSwap, submitLimitOrder, submitGrant, and keeper fill return the transaction hash "
        "without waiting for a receipt. The UI may report success before mining. By contrast, "
        "the copilot browser helpers wait for receipts. The indexer is the later evidence that "
        "an autonomous action actually emitted settlement events.",
        "warn",
    )
)
story.append(H("6.5 The second signature: per-action agent intent", 2))
story.append(
    data_table(
        ["Intent", "Signed fields"],
        [
            ["SwapIntent", "user, tokenIn, tokenOut, amountIn, minAmountOut, nonce, deadline"],
            ["LimitIntent", "user, tokenIn, tokenOut, amountIn, minAmountOut, triggerPrice, triggerAbove, expiry, nonce, deadline"],
        ],
        [34 * mm, CONTENT_W - 34 * mm],
    )
)
story.append(
    P(
        "The relayer transaction sender and the agent intent signer are separate roles. The relayer "
        "pays gas and delivers calldata. AgentExecutor ignores the transaction sender for capability "
        "authorization and instead recovers the EIP-712 signer from the inner signature."
    )
)
story.append(H("6.6 On-chain authorization order", 2))
story.extend(
    numbers(
        [
            "Reject zero input.",
            "Reject an expired per-action deadline.",
            "Require both tokenIn and tokenOut to be globally registered.",
            "Load the user's capability and require exists, not revoked, and not expired.",
            "Recover the EIP-712 signer and require equality with capability.agentSigner.",
            "Reject a used nonce, then mark the nonce used. Any later revert rolls this state change back atomically.",
            "Value tokenIn amount in 1e18 USD. Stables are fixed at one dollar; other assets use the registered Chainlink feed and token/feed decimals.",
            "Reject value above maxPerTradeUsd.",
            "Add value to dailyUsdSpent[user][block.timestamp / 1 days] and reject totals above maxDailyUsd.",
            "For swaps, read a fresh router quote and reject minAmountOut below the capability's slippage floor.",
            "Debit the user's vault and proceed to the typed execution path.",
        ]
    )
)
story.append(
    callout(
        "Daily means epoch day, not rolling day",
        "The accounting key is integer division of block.timestamp by one day. Spend resets at "
        "the UTC day boundary. It is not a trailing 24-hour window.",
        "info",
    )
)
story.append(H("6.7 Autonomous market-swap settlement", 2))
story.extend(
    numbers(
        [
            "AgentExecutor debits vaultBalance[user][tokenIn].",
            "It grants the router an exact allowance with forceApprove.",
            "The router pulls tokenIn from AgentExecutor and forwards it into the selected pool.",
            "LiquidityPool computes amountOut with x*y=k and a 30 bps input fee, then checks minAmountOut.",
            "The pool transfers tokenOut back to AgentExecutor and syncs reserves to real balances.",
            "AgentExecutor credits vaultBalance[user][tokenOut] and emits AgentSwap with the Chainlink USD value.",
        ]
    )
)
story.append(
    callout(
        "Output custody",
        "An autonomous market swap keeps the output inside the user's executor vault. The user "
        "must withdraw it with their own wallet to return it to the main wallet.",
        "safe",
    )
)
story.append(H("6.8 Autonomous limit-order creation and later fill", 2))
story.extend(
    numbers(
        [
            "The same authorization path books the action against per-trade and daily USD caps at order creation time.",
            "AgentExecutor debits the vault and approves OrderBook.",
            "OrderBook.createOrderFor pulls the input, records the user as owner, and escrows the funds.",
            "The current backend computes minAmountOut from the pool quote at creation time, unlike the copilot builder's trigger-aware oracle calculation.",
            "The order receives a seven-day expiry and an ETH/USD trigger scaled to eight decimals.",
            "A later keeper or any third party calls executeOrder only when it believes the trigger is met.",
            "OrderBook independently rechecks open status, expiry, Chainlink positivity, maximum staleness, and trigger direction.",
            "The order is marked Filled, the router swap executes, and output is sent directly to the order owner. If the router reverts, the entire fill including the status change reverts.",
        ]
    )
)
story.append(
    callout(
        "Important custody and revocation behavior",
        "Autonomous limit-order output goes to the user's wallet, not back to the executor vault. "
        "Revoking the capability stops new agent actions but does not cancel an already escrowed "
        "order. That order can still fill until expiry or user cancellation.",
        "warn",
    )
)

# 7
story.append(H("7. Solidity Contract Architecture"))
story.append(H("7.1 TestToken and FaucetRouter", 2))
story.append(
    P(
        "Each of the ten tradable assets is an OpenZeppelin ERC-20 with configured decimals and a "
        "metered faucet. A faucet pull is sized near USD 1,000 using deployment-time prices and is "
        "capped at five claims per address. FaucetRouter batches all token faucets in one transaction "
        "and catches individual failures so exhausted assets do not revert the entire batch."
    )
)
story.append(H("7.2 Complete pool mesh", 2))
story.append(
    P(
        "The deploy script creates one pool for every unordered pair of ten assets: 10 * 9 / 2 = 45 "
        "pools. Every pair therefore routes in one hop. Each side is seeded with approximately USD "
        "1,000,000 at the deployment-time Chainlink price, and every pool charges 30 basis points."
    )
)
story.append(
    data_table(
        ["Property", "Implementation"],
        [
            ["Curve", code("x * y = k") + " constant-product AMM."],
            ["Quote", code("amountInWithFee * reserveOut / (reserveIn * BPS + amountInWithFee)")],
            ["Liquidity shares", "Internal share accounting; first deposit locks MINIMUM_LIQUIDITY."],
            ["Token order", "Canonical address sorting into token0/token1."],
            ["Reserve updates", "Explicit accounting for liquidity; post-swap sync from actual ERC-20 balances."],
            ["Reentrancy", "addLiquidity, removeLiquidity, and swap are nonReentrant."],
        ],
        [39 * mm, CONTENT_W - 39 * mm],
    )
)
story.append(H("7.3 DEXRouter", 2))
story.extend(
    bullets(
        [
            "Ownable registry maps an order-independent pair key to one pool.",
            "quoteSwap delegates directly to the pool's getAmountOut.",
            "swapExactTokensForTokens enforces a deadline and nonzero recipient.",
            "The router is intentionally thin and does not maintain balances between completed calls.",
            "All user, executor, and order-book swaps converge on this same code path and emit RouterSwap.",
        ]
    )
)
story.append(H("7.4 OrderBook state machine", 2))
story.append(
    data_table(
        ["State", "Entry", "Exit"],
        [
            ["None", "Unallocated id.", "createOrder or createOrderFor -> Open."],
            ["Open", "Input escrowed; owner and trigger recorded.", "executeOrder -> Filled, cancelOrder -> Cancelled."],
            ["Filled", "Trigger and router swap succeeded atomically.", "Terminal."],
            ["Cancelled", "Escrow returned to owner.", "Terminal."],
        ],
        [24 * mm, 73 * mm, CONTENT_W - 97 * mm],
    )
)
story.extend(
    bullets(
        [
            "Only the configured AgentExecutor can call createOrderFor.",
            "Anyone can call executeOrder; the caller has no pricing authority.",
            "The single configured price feed is ETH/USD. Interpreter and browser code restrict limit intents to pairs containing rWETH.",
            "A feed answer older than maxPriceStaleness (24 hours by default) blocks execution.",
            "Only the owner or AgentExecutor address may cancel, but the shipped AgentExecutor exposes no cancel wrapper, so normal autonomous cancellation is user-signed.",
        ]
    )
)
story.append(H("7.5 AgentExecutor as the authorization choke point", 2))
story.append(
    P(
        "AgentExecutor combines token valuation, isolated custody, delegated authority, replay "
        "protection, spend accounting, and typed dispatch. Its security property comes from having "
        "only two agent action entry points: executeSwap and createLimitOrder. There is no generic "
        "execute(target, calldata) function."
    )
)
story.append(
    data_table(
        ["State mapping", "Purpose"],
        [
            [code("tokenInfo[token]"), "Global registration, decimals, stable flag, and Chainlink feed."],
            [code("vaultBalance[user][token]"), "Only token inventory available to autonomous actions."],
            [code("capabilities[user]"), "Current signer and policy bounds."],
            [code("usedNonce[user][nonce]"), "One-time per-action replay protection."],
            [code("grantNonce[user]"), "One-time capability-signature replay protection."],
            [code("dailyUsdSpent[user][day]"), "Input notional already booked in the current epoch day."],
        ],
        [57 * mm, CONTENT_W - 57 * mm],
    )
)
story.append(H("7.6 Administrative trust", 2))
story.append(
    P(
        "The contracts are not fully governance-minimized. DEXRouter owner can register pair mappings; "
        "OrderBook owner can replace the price feed, staleness threshold, and agent executor; "
        "AgentExecutor owner can register token valuation metadata; TestToken owner can mint. "
        "Those powers are appropriate for a testnet demo but must be included in a production threat model."
    )
)

# 8
story.append(H("8. Keeper, Indexer, and Database"))
story.append(H("8.1 Keeper loop", 2))
story.extend(
    numbers(
        [
            "Read nextOrderId.",
            "Iterate every historical id from 1 to nextOrderId - 1.",
            "Read each order and skip non-open states.",
            "Call isTriggered for every open order.",
            "For triggered orders, encode executeOrder(id) and broadcast from the relayer wallet.",
            "Record hash or error in the tick result; retry naturally on the next 15-second loop.",
        ]
    )
)
story.append(
    callout(
        "Keeper safety and liveness",
        "The keeper cannot force an untriggered fill because OrderBook repeats the oracle check. "
        "If the keeper is offline or Latch denies its RPC call, funds remain escrowed and the order "
        "waits. The present scan is O(total orders), including terminal orders, and will need event- "
        "or index-based optimization at larger scale.",
        "info",
    )
)
story.append(H("8.2 Indexer loop", 2))
story.extend(
    bullets(
        [
            "Starts at the configured AgentExecutor deployment block and scans at most 800 blocks per window.",
            "Reads AgentSwap, OrderCreated, OrderFilled, OrderCancelled, and RouterSwap in parallel.",
            "Skips RouterSwap events whose sender is AgentExecutor or OrderBook to avoid double-counting.",
            "Fetches each event block timestamp once and inserts normalized trade rows.",
            "Uses UNIQUE(tx_hash, log_index) plus ON CONFLICT DO NOTHING for idempotence.",
            "Persists last_block in indexer_state and catches up to head every 20 seconds.",
        ]
    )
)
story.append(
    callout(
        "Finality caveat",
        "The indexer scans to the current head with no confirmation depth and does not implement "
        "reorg rollback. This is acceptable for a Sepolia demo but not a complete production indexer.",
        "warn",
    )
)
story.append(H("8.3 Intent and trade records", 2))
story.append(
    data_table(
        ["Table", "Role", "Current lifecycle"],
        [
            ["intents", "Original command, parsed fields, status, errors, tx hash.", "interpreting -> rejected/ready -> submitted or failed. signed and confirmed are allowed by schema but not currently set."],
            ["trades", "Event-derived flat history for activity display.", "Inserted only from Sepolia logs; never authoritative over chain state."],
            ["indexer_state", "Restart-safe block bookmark.", "Advanced after each successfully scanned window."],
        ],
        [28 * mm, 62 * mm, CONTENT_W - 90 * mm],
    )
)
story.append(H("8.4 Two backend hosting shapes", 2))
story.append(
    data_table(
        ["Shape", "Behavior"],
        [
            ["Next.js server routes", "Thin route files call the same core handlers. Keeper/indexer run through secret-guarded cron endpoints."],
            ["Fastify relayer", "Thin HTTP shell over core handlers. Starts in-process keeper and indexer loops after listen."],
        ],
        [39 * mm, CONTENT_W - 39 * mm],
    )
)

# 9
story.append(H("9. Latch's Role in Autonomous Mode"))
story.append(
    P(
        "In the current repository, Latch is an optional outbound RPC boundary. It is activated only "
        "when both LATCH_RPC_URL and LATCH_TOKEN are set. The viem wallet still signs locally with "
        "the relayer private key; its transport then sends the JSON-RPC request to Latch with "
        "Authorization: Bearer lat_... instead of sending directly to the configured Sepolia RPC."
    )
)
story.append(H("9.1 Exact placement", 2))
story.append(
    flow_strip(
        [
            ("1", "Local construction", "Core encodes AgentExecutor or OrderBook calldata."),
            ("2", "Local signing", "Viem signs with the relayer gas-payer private key."),
            ("3", "Latch proxy", "Bearer token identifies upstream and policy; request may be allowed or denied."),
            ("4", "Sepolia RPC", "Allowed raw transaction is broadcast; the chain may mine or revert it."),
        ]
    )
)
story.append(Spacer(1, 6))
story.append(
    data_table(
        ["Traffic", "Uses Latch when configured?"],
        [
            ["Autonomous market-swap broadcasts", "Yes"],
            ["Autonomous limit-order creation broadcasts", "Yes"],
            ["Gas-sponsored capability grant broadcasts", "Yes"],
            ["Keeper executeOrder broadcasts", "Yes"],
            ["Sepolia reads and quotes", "No; direct publicClient transport"],
            ["Copilot user-wallet transactions", "No; sent through the connected wallet provider"],
            ["GenLayer writes/reads", "No"],
            ["Agent EIP-712 signature creation", "No; local AGENT_SIGNER_PRIVATE_KEY"],
        ],
        [82 * mm, CONTENT_W - 82 * mm],
    )
)
story.append(H("9.2 What Latch contributes", 2))
story.extend(
    bullets(
        [
            "Credential separation: the relayer can hold a scoped latch token while the real upstream credential remains stored and injected by Latch.",
            "Independent revocation: deleting or disabling a latch can stop proxy access without rotating the upstream provider key.",
            "Ordered request policy: endpoint, HTTP method, payload, body size, time window, IP, identity, rate, custom code, and related filters can deny before the upstream is called.",
            "Activity trace: allowed and denied calls are recorded with the filter decision path; request/response body logging is optional.",
            "Operational containment: a compromised process that has only the latch token is limited by the external policy rather than inheriting the full upstream credential.",
            "Incremental integration: Roque changes only the viem transport URL and Authorization header; contract logic remains independent.",
        ]
    )
)
story.append(H("9.3 What Latch does not do in this code", 2))
story.extend(
    bullets(
        [
            "It does not hold or use AGENT_SIGNER_PRIVATE_KEY.",
            "It does not hold or use the relayer private key; viem signs locally before proxying.",
            "It does not validate the user's on-chain capability. AgentExecutor does.",
            "It does not make a transaction final or successful. It only controls whether a request reaches the upstream RPC.",
            "The repository contains no checked-in Latch pipeline definition, so active filters, rate limits, identities, and spend policy cannot be verified from source.",
            "A stolen local private key can broadcast through another RPC unless infrastructure prevents egress. Latch is not key custody in the present integration.",
        ]
    )
)
story.append(
    callout(
        "Fine-grained EVM policy needs more work",
        "The proxied write is normally eth_sendRawTransaction with opaque signed bytes in params[0]. "
        "A payload filter can allow only the JSON-RPC method, but contract/function/value allowlisting "
        "requires transaction decoding in custom policy or a redesigned Latch/TEE signing path. "
        "A model-based spend_limit is not automatically an Ethereum gas or token-spend limit.",
        "risk",
    )
)
story.append(H("9.4 Recommended Latch policy for Roque", 2))
story.extend(
    numbers(
        [
            "Bind the production RPC credential as a write-only Secret and issue a dedicated latch for Roque's relayer.",
            "Allow only HTTP POST and the exact JSON-RPC proxy path used by the provider.",
            "Require JSON-RPC 2.0 and allow $.method only as eth_sendRawTransaction for the write latch.",
            "Set a conservative request rate compatible with autonomous execution and keeper cadence.",
            "Apply body-size limits and IP allowlisting or hardware-bound identity for the relayer host.",
            "Disable request-body logging if raw signed transactions are considered sensitive operational data; keep decision metadata.",
            "Use a separate read latch only if protected provider reads are needed. The current application reads directly.",
            "For real transaction-content controls, add audited transaction decoding/custom code or move signing into an enclave-backed EVM signer design.",
        ]
    )
)

# 10
story.append(H("10. Why Rialo/Latch Helps Roque Users"))
story.append(
    P(
        "Roque's concrete Rialo-facing integration today is Latch. Its value is not another copy of "
        "the on-chain capability; it is a separate control plane around the off-chain machinery that "
        "uses credentials and broadcasts transactions."
    )
)
story.append(
    data_table(
        ["User benefit", "Technical reason"],
        [
            ["Smaller off-chain blast radius", "A scoped, revocable proxy token can replace direct possession of the upstream credential."],
            ["Defense in depth", "Latch can reject the relayer request before RPC while AgentExecutor independently rejects invalid financial actions on-chain."],
            ["Auditable automation", "Latch records attempted access decisions; Sepolia records accepted transactions and settlement events."],
            ["Faster operational shutdown", "Operators can revoke proxy access immediately while users retain the separate on-chain revoke path."],
            ["Safer always-on behavior", "Rate, time, identity, endpoint, and payload policy can contain runaway relayer/keeper traffic."],
            ["Better UX without surrendering custody", "Gas-sponsored grants and autonomous broadcasts avoid repeated wallet popups while the vault and contract caps retain hard limits."],
            ["Graceful degradation", "Copilot user-signed trading does not depend on Latch or the relayer wallet path."],
        ],
        [48 * mm, CONTENT_W - 48 * mm],
    )
)
story.append(H("10.1 Architectural fit with broader Rialo capabilities", 2))
story.append(
    P(
        "The current settlement chain is Sepolia and the current timer is an off-chain keeper. "
        "Rialo's published direction around infrastructure for intelligent systems, configurable "
        "privacy, and reactive transactions is relevant as an evolution path, not as a description "
        "of deployed Roque behavior."
    )
)
story.extend(
    bullets(
        [
            "Native reactive automation could replace or reduce the centralized 15-second keeper loop for time/event-triggered orders.",
            "Configurable privacy could protect sensitive mandates, policy parameters, or external evidence while preserving verifiable execution.",
            "A native confidential execution/signing path could remove raw agent and relayer keys from the application environment.",
            "Moving policy and automation closer to the execution environment could reduce the number of independently operated services required for an autonomous order.",
        ]
    )
)
story.append(
    callout(
        "Implemented versus potential",
        "None of the broader Rialo-native items above are present in this repository snapshot. "
        "They are concrete architecture opportunities inferred from Roque's current keeper, "
        "credential, privacy, and cross-system coordination needs.",
        "info",
    )
)

# 11
story.append(H("11. Security Model and Failure Analysis"))
story.append(H("11.1 Enforced invariants", 2))
story.append(
    data_table(
        ["Invariant", "Enforcer"],
        [
            ["Only registered tokens can enter an autonomous intent.", "AgentExecutor tokenInfo checks; shared registry and interpreter also validate earlier."],
            ["Only the configured agent signer authorizes an action.", "EIP-712 recovery against capability.agentSigner."],
            ["One signed intent cannot be replayed.", "usedNonce per user."],
            ["Stale action signatures expire.", "Intent deadline."],
            ["Delegation expires or can be revoked.", "Capability validUntil and revoked."],
            ["Input notional is bounded per action and day.", "Chainlink usdValue and dailyUsdSpent."],
            ["The agent cannot accept arbitrary slippage.", "Fresh router quote and capability maxSlippageBps."],
            ["The agent cannot spend the main wallet.", "Vault-only debit and user-only deposit/withdraw."],
            ["Keeper cannot force an untriggered order.", "OrderBook oracle, expiry, and status checks."],
            ["AMM output cannot fall below signed/constructed floor.", "LiquidityPool minAmountOut check."],
        ],
        [69 * mm, CONTENT_W - 69 * mm],
        small=True,
    )
)
story.append(H("11.2 Threat and failure matrix", 2))
story.append(
    data_table(
        ["Failure / compromise", "Effect", "Residual control"],
        [
            ["LLM misreads command", "May produce a wrong but normalized intent.", "User review in copilot/confirm; vault and capability caps in autonomous."],
            ["GenLayer unavailable", "Interpretation fails after retries.", "Direct contract functionality and existing order settlement remain; no new chat intent."],
            ["Neon unavailable", "Intent creation/execution history fails.", "Sepolia funds remain unaffected; autonomous endpoint depends on stored intent."],
            ["Database modified", "Stored interpretation can be changed before execution.", "On-chain caps still bound value, but GenLayer provenance is not cryptographically bound to calldata."],
            ["Agent signer stolen", "Attacker can produce valid per-action signatures.", "Capability, vault, limits, deadlines, and nonces remain."],
            ["Relayer key stolen", "Attacker can spend relayer gas and broadcast arbitrary public calls.", "Cannot debit vault without a valid agent signature; Latch is bypassable through another RPC if the key is exfiltrated."],
            ["Latch token stolen", "Attacker can use the configured proxy within its policy.", "Real upstream secret is not disclosed; policy, identity, rate, and revocation can constrain access."],
            ["Latch unavailable/denies", "Autonomous broadcasts, gas-sponsored grants, and keeper fills fail.", "Copilot user-wallet writes and direct reads bypass Latch; escrow remains safe."],
            ["Keeper offline", "Triggered orders wait.", "Anyone may execute; contract checks still protect."],
            ["Chainlink stale/bad", "Executor valuation or order fill reverts.", "Fail-closed behavior; no fallback oracle in contracts."],
            ["Pool moves after quote", "Swap may receive less or revert.", "minAmountOut and deadline enforce the user's/agent's floor."],
        ],
        [44 * mm, 58 * mm, CONTENT_W - 102 * mm],
        small=True,
    )
)
story.append(H("11.3 Current implementation risks and production work", 2))
story.extend(
    bullets(
        [
            "POST /execute is unauthenticated, loads an intent only by id, and does not verify that the intent belongs to the supplied user or was created in autonomous mode.",
            "The same ready intent can be executed repeatedly at the application layer because every call receives a fresh on-chain nonce. The nonce blocks replay of one signed payload, not repeated re-signing of one database intent.",
            "Activity endpoints expose intent ids by user address. Combined with the previous point, ownership checks and transactional status locking are production requirements.",
            "Autonomous submission does not wait for a receipt, and intent status is not advanced to confirmed by the indexer.",
            "The copilot confirm endpoint accepts a transaction hash without verifying sender, calldata, receipt status, or event correspondence.",
            "Raw agent and relayer private keys remain environment secrets. Latch currently protects RPC egress, not signing custody.",
            "Capability has no per-user token allowlist or action bitmap. Any globally registered pair and either implemented action are available within numeric bounds.",
            "Daily spend is a UTC epoch-day bucket. Capability replacement does not clear already booked spend for that day.",
            "Creating a limit order consumes daily capacity immediately even if it never fills.",
            "Revoking a capability does not cancel open orders already in OrderBook escrow.",
            "The autonomous limit minOut is based on the current pool quote, while the copilot limit builder derives a trigger-aware oracle floor. The two modes can behave differently at fill time.",
            "OrderBook supports only one ETH/USD trigger feed and allows a 24-hour price age by default.",
            "Keeper complexity grows with every historical order id, and the indexer lacks reorg reconciliation.",
            "The GenLayer adjudicate function exists but is not wired into the live trade lifecycle; fuzzy news/event mandates are therefore not currently autonomous features.",
            "buildContext passes token symbols and ETH/USD only, not user balances, positions, or block-pinned Sepolia state described in older plans.",
            "Contract-owner powers and test-token minting are central administrative trust assumptions.",
        ]
    )
)
story.append(
    callout(
        "Highest priority hardening",
        "Authenticate execution requests, bind intent ownership and mode, atomically transition ready "
        "to executing, reject already-submitted intents, wait for receipts, bind the executed payload "
        "to the finalized GenLayer result, and move signing into a non-exportable policy-controlled "
        "key service.",
        "risk",
    )
)

# 12
story.append(H("12. Operational Behavior and Configuration"))
story.append(H("12.1 Required server configuration", 2))
story.append(
    data_table(
        ["Variable", "Purpose"],
        [
            [code("SEPOLIA_RPC_URL"), "Direct read RPC and write fallback when Latch is disabled."],
            [code("AGENT_SIGNER_PRIVATE_KEY"), "Signs SwapIntent and LimitIntent typed data."],
            [code("RELAYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY"), "Signs and pays gas for backend Sepolia transactions."],
            [code("DATABASE_URL"), "Neon intent notebook, trade cache, and indexer state."],
            [code("GENLAYER_RPC_URL / GENLAYER_CONTRACT_ADDRESS"), "Intelligent-contract write/wait/read path."],
            [code("LATCH_RPC_URL / LATCH_TOKEN"), "Optional replacement transport for relayer wallet broadcasts."],
            [code("CRON_SECRET"), "Guards Next.js keeper and indexer routes."],
        ],
        [62 * mm, CONTENT_W - 62 * mm],
    )
)
story.append(H("12.2 Retry and polling behavior", 2))
story.append(
    data_table(
        ["Subsystem", "Behavior"],
        [
            ["GenLayer network call", "Up to four attempts for transient errors; receipt polling 30 times every four seconds."],
            ["Neon query", "Up to four attempts with increasing 250 ms delay for transient network errors."],
            ["Market/capability UI reads", "Polling intervals range from 12 to 20 seconds."],
            ["Standalone keeper", "Every 15 seconds, with errors isolated to the tick."],
            ["Standalone indexer", "Every 20 seconds, catches up in 800-block windows."],
            ["Next.js cron", "Secret-guarded routes with maxDuration 60 seconds; external schedule configured by deployment."],
        ],
        [46 * mm, CONTENT_W - 46 * mm],
    )
)
story.append(H("12.3 Completion semantics by action", 2))
story.append(
    data_table(
        ["Action", "When caller receives success"],
        [
            ["Copilot swap / limit / vault / revoke", "After publicClient.waitForTransactionReceipt returns."],
            ["Autonomous swap / limit", "After sendTransaction returns a hash; not necessarily mined."],
            ["Gas-sponsored grant", "After sendTransaction returns a hash; capability may not be readable yet."],
            ["Keeper fill", "After sendTransaction returns a hash; later tick/indexer reflects result."],
            ["Trade history", "After indexer observes the relevant event and inserts it into Neon."],
        ],
        [52 * mm, CONTENT_W - 52 * mm],
    )
)

# 13
story.append(H("13. Testing and Verification Evidence"))
story.append(
    P(
        f"Verification was run against repository snapshot {code(COMMIT)} on {esc(DOC_DATE)}. "
        "The documentation generator does not modify application or contract code."
    )
)
story.append(
    data_table(
        ["Suite", "Result", "Coverage signal"],
        [
            ["Workspace TypeScript", "All four workspace projects passed.", "Shared types, backend, relayer, and web compile together."],
            ["Core Vitest", "9 passed.", "Slippage math, trigger scaling, and EIP-712 recovery/signature sensitivity."],
            ["GenLayer pytest", "28 passed.", "Normalization happy paths, aliases, exact-output rejection, malformed model output, limits, and adjudication fallback."],
            ["Foundry", "60 passed across 6 suites.", "AMM, router, order book, executor caps/replay/revoke/expiry/slippage/vault, faucet, and fuzz properties."],
        ],
        [39 * mm, 33 * mm, CONTENT_W - 72 * mm],
    )
)
story.append(H("13.1 Particularly important tested rejection paths", 2))
story.extend(
    bullets(
        [
            "Wrong agent signer.",
            "Per-trade and daily-cap excess.",
            "Reused nonce.",
            "Revoked or expired capability.",
            "Expired action intent.",
            "Excessive slippage.",
            "Missing capability or insufficient vault.",
            "Untriggered, expired, stale-price, double-filled, and unauthorized-cancel limit orders.",
            "Unknown token, self trade, zero/non-numeric amount, out-of-range percentage, unsupported limit pair, and exact-output language.",
        ]
    )
)

# 14
story.append(H("14. Token and Oracle Registry"))
token_rows: list[list[object]] = []
for idx, symbol in enumerate(DEPLOYMENT["tokenSymbols"]):
    token_rows.append(
        [
            symbol,
            DEPLOYMENT["tokenDecimals"][idx],
            "Yes" if DEPLOYMENT["tokenIsStable"][idx] else "No",
            code(DEPLOYMENT["tokenAddresses"][idx]),
            "Fixed USD 1"
            if DEPLOYMENT["tokenIsStable"][idx]
            else code(DEPLOYMENT["tokenFeeds"][idx]),
        ]
    )
story.append(
    data_table(
        ["Symbol", "Decimals", "Stable", "Token address", "Valuation source"],
        token_rows,
        [18 * mm, 16 * mm, 15 * mm, 61 * mm, CONTENT_W - 110 * mm],
        small=True,
    )
)
story.append(
    P(
        "Every unordered pair has one deployed pool. The complete symbol/address matrix is stored "
        f"in {code('packages/shared/src/deployment.json')} and is zipped into typed metadata by "
        f"{code('packages/shared/src/index.ts')}."
    )
)

# 15
story.append(H("15. Code Map for Maintainers"))
story.append(
    data_table(
        ["Lifecycle concern", "Primary files / functions"],
        [
            ["HTTP validation and handlers", code("packages/core/src/api.ts")],
            ["Request lifecycle and autonomous orchestration", code("packages/core/src/services.ts")],
            ["GenLayer client and retries", code("packages/core/src/genlayer.ts")],
            ["Agent signatures and relayer submissions", code("packages/core/src/intents.ts")],
            ["Sepolia and Latch transports", code("packages/core/src/chain.ts") + ", " + code("env.ts")],
            ["Quotes and slippage", code("packages/core/src/quote.ts")],
            ["Chainlink valuation", code("packages/core/src/prices.ts")],
            ["Keeper", code("packages/core/src/keeper.ts")],
            ["Indexer", code("packages/core/src/indexer.ts")],
            ["Neon schema and query retries", code("packages/core/src/db/index.ts")],
            ["Natural-language contract", code("packages/genlayer/contracts/roque_interpreter.py")],
            ["Capability and vault enforcement", code("contracts/src/AgentExecutor.sol")],
            ["Resting orders and oracle trigger", code("contracts/src/OrderBook.sol")],
            ["Router and AMM", code("contracts/src/DEXRouter.sol") + ", " + code("LiquidityPool.sol")],
            ["Current shared addresses/types", code("packages/shared/src/index.ts") + ", " + code("deployment.json")],
        ],
        [59 * mm, CONTENT_W - 59 * mm],
        small=True,
    )
)

# 16
story.append(H("16. External Technical References"))
story.append(
    P(
        "These references were used only to validate platform semantics around GenLayer consensus, "
        "Latch proxy policy, and Rialo's published direction. Repository code remains the source of "
        "truth for what Roque currently implements."
    )
)
story.append(
    data_table(
        ["Topic", "Official source"],
        [
            ["GenLayer intelligent contracts", code("https://docs.genlayer.com/developers/intelligent-contracts/introduction")],
            ["GenLayer equivalence principle", code("https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle")],
            ["Latch quickstart", code("https://onlatch.com/docs/get-started/quickstart")],
            ["Latch secrets and scoped tokens", code("https://onlatch.com/docs/get-started/secrets") + "<br/>" + code("https://onlatch.com/docs/get-started/latches")],
            ["Latch policy pipeline and filters", code("https://onlatch.com/docs/filters/pipeline") + "<br/>" + code("https://onlatch.com/docs/filters/reference")],
            ["Latch activity and proxy API", code("https://onlatch.com/docs/guides/activity") + "<br/>" + code("https://onlatch.com/docs/reference/proxy-api")],
            ["Rialo overview", code("https://www.rialo.io")],
            ["Rialo reactive transactions", code("https://www.rialo.io/posts/reactive-transactions-a-model-for-native-automation-on-rialo")],
        ],
        [47 * mm, CONTENT_W - 47 * mm],
        small=True,
    )
)
story.append(Spacer(1, 8))
story.append(
    callout(
        "Bottom line",
        "Roque's core architectural achievement is not that an AI can trade. It is that language "
        "understanding, delegated permission, off-chain operations, and token settlement are split "
        "across independent boundaries. The user experience becomes simpler while the financial "
        "authority remains explicit, revocable, measurable, and enforced by contracts.",
        "safe",
    )
)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = RoqueDocTemplate(str(OUT))
    doc.multiBuild(story)
    print(OUT)


if __name__ == "__main__":
    main()
