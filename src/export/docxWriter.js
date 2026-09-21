import {
  AlignmentType, Document, ExternalHyperlink, HeadingLevel, PageBreak, Packer,
  Paragraph, ShadingType, Table, TableCell, TableOfContents, TableRow, TextRun, WidthType,
} from 'docx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { groupBySystem } from '../discovery/classify.js';

const ACCENT = '1F4E79';
const MUTED = '595959';

export async function writeDossierDocx(dossier, plan, outputPath) {
  const items = new Map(dossier.catalogue.map((i) => [i.id, i]));

  const children = [
    ...titleBlock(dossier),
    ...summaryBlock(plan),
    ...tocBlock(),
    ...timelineBlock(plan, items),
    ...readingOrderBlock(plan, items),
    ...linkInventoryBlock(dossier),
    ...coverageBlock(dossier, plan),
  ];

  const doc = new Document({
    creator: 'The Searcher',
    title: `${dossier.term} - Research Dossier`,
    description: `Origin-to-current-state dossier for "${dossier.term}"`,
    sections: [{ properties: {}, children }],
  });

  const buffer = await Packer.toBuffer(doc);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buffer);
  return outputPath;
}

// --- blocks -----------------------------------------------------------------

function titleBlock(dossier) {
  const generated = new Date(dossier.generatedAt).toLocaleString('en-GB', { timeZone: 'UTC' });
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 2400, after: 120 },
      children: [new TextRun({ text: dossier.term, bold: true, size: 72, color: ACCENT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 600 },
      children: [new TextRun({ text: 'Research Dossier - origin to current state', size: 28, color: MUTED })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Generated ${generated} UTC`, size: 20, color: MUTED })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: `${dossier.stats.pageCount} pages | ${dossier.stats.linkCount} links | ` +
                `${(dossier.resources || []).length} resources followed | ${dossier.spaces.length} spaces`,
          size: 20, color: MUTED,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Source: ${dossier.baseUrl}`, size: 20, color: MUTED })],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function summaryBlock(plan) {
  const out = [heading('Executive Summary', HeadingLevel.HEADING_1)];
  if (plan.summary) out.push(body(plan.summary));
  if (plan.whatItIs) {
    out.push(heading('In one line', HeadingLevel.HEADING_2), body(plan.whatItIs));
  }
  if (plan.currentState) {
    out.push(heading('Where it stands now', HeadingLevel.HEADING_2), body(plan.currentState));
  }
  return out;
}

function tocBlock() {
  return [
    new Paragraph({ children: [new PageBreak()] }),
    heading('Contents', HeadingLevel.HEADING_1),
    new Paragraph({
      children: [new TextRun({
        text: 'Right-click and choose "Update field" in Word to populate.',
        italics: true, size: 18, color: MUTED,
      })],
    }),
    new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function timelineBlock(plan, items) {
  if (!plan.timeline?.length) return [];

  const rows = [headerRow(['Date', 'Event', 'Source'])];
  for (const entry of plan.timeline) {
    const item = items.get(entry.itemId);
    rows.push(
      new TableRow({
        children: [
          cell([new Paragraph({ children: [new TextRun({ text: String(entry.date).slice(0, 10), size: 20 })] })], 15),
          cell([new Paragraph({ children: [new TextRun({ text: entry.event || '', size: 20 })] })], 55),
          cell([item
            ? linkParagraph(item.title, item.url, 18)
            : new Paragraph({ children: [new TextRun({ text: '-', size: 18 })] })], 30),
        ],
      })
    );
  }

  return [
    heading('Timeline', HeadingLevel.HEADING_1),
    body('Reconstructed from creation and modification dates recorded in the source systems.'),
    new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function readingOrderBlock(plan, items) {
  const out = [
    heading('Reading Order', HeadingLevel.HEADING_1),
    body('Sections are ordered so understanding builds from origin through to current state.'),
  ];

  plan.sections.forEach((section, index) => {
    out.push(heading(`${index + 1}. ${section.title}`, HeadingLevel.HEADING_2));
    if (section.purpose) {
      out.push(new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun({ text: section.purpose, italics: true, size: 20, color: MUTED })],
      }));
    }

    for (const id of section.itemIds) {
      const item = items.get(id);
      if (!item) continue;

      out.push(new Paragraph({
        spacing: { before: 160, after: 40 },
        children: [
          new TextRun({ text: '> ', color: ACCENT, bold: true }),
          ...linkRuns(item.title, item.url, 22, true),
        ],
      }));

      const meta = [
        prettyType(item.type),
        item.space,
        item.status,
        item.updated ? `updated ${String(item.updated).slice(0, 10)}` : null,
      ].filter(Boolean).join(' | ');

      if (meta) {
        out.push(new Paragraph({
          spacing: { after: 40 },
          children: [new TextRun({ text: meta, size: 18, color: MUTED })],
        }));
      }
      if (item.excerpt) {
        out.push(new Paragraph({
          spacing: { after: 80 },
          indent: { left: 240 },
          children: [new TextRun({ text: item.excerpt, size: 19 })],
        }));
      }
    }
  });

  out.push(new Paragraph({ children: [new PageBreak()] }));
  return out;
}

function linkInventoryBlock(dossier) {
  const out = [
    heading('Link Inventory', HeadingLevel.HEADING_1),
    body('Every outbound reference found on the pages above, grouped by the system it points to. Counts show how many pages cite each link - frequently cited links are usually the canonical ones.'),
  ];

  for (const group of groupBySystem(dossier.links)) {
    out.push(heading(`${group.label} (${group.items.length})`, HeadingLevel.HEADING_2));

    for (const link of group.items) {
      const label = link.text || link.issueKey || link.url;
      out.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 20 },
        children: [
          ...linkRuns(label, link.url, 20, false),
          new TextRun({
            text: link.sources.length > 1 ? `  (cited by ${link.sources.length} pages)` : '',
            size: 16, color: MUTED,
          }),
        ],
      }));
    }
  }

  out.push(new Paragraph({ children: [new PageBreak()] }));
  return out;
}

function coverageBlock(dossier, plan) {
  const out = [
    heading('Coverage & Gaps', HeadingLevel.HEADING_1),
    body('What this dossier did and did not reach, so its blind spots are explicit.'),
  ];

  const sp = dossier.spacePlan;
  if (sp?.focus?.length) {
    out.push(heading('Spaces investigated', HeadingLevel.HEADING_2));
    out.push(body(
      sp.mode === 'auto'
        ? `The Searcher ranked ${sp.considered} space(s) with hits by evidence density and focused on ${sp.focus.length}. Pages elsewhere were kept only when they mention the topic directly.`
        : 'Spaces were specified manually for this run.'
    ));
    for (const f of sp.focus) {
      const detail = sp.mode === 'auto'
        ? ` - score ${f.score} (${f.hits} hits, ${f.mentions} mentions, ${f.titleMatches} title match${f.titleMatches === 1 ? '' : 'es'})`
        : '';
      out.push(new Paragraph({
        bullet: { level: 0 },
        children: [
          new TextRun({ text: f.name ? `${f.name} (${f.key})` : f.key, bold: true, size: 20 }),
          new TextRun({ text: detail, size: 20, color: MUTED }),
        ],
      }));
    }
    const rest = (sp.ranked || []).filter((r) => !sp.focus.some((f) => f.key === r.key));
    if (rest.length) {
      out.push(new Paragraph({
        spacing: { before: 80 },
        children: [new TextRun({
          text: `Also seen but not expanded: ${rest.map((r) => `${r.key} (${r.score})`).join(', ')}.`,
          size: 18, color: MUTED, italics: true,
        })],
      }));
    }
  }

  out.push(heading('Connectors', HeadingLevel.HEADING_2));
  for (const c of dossier.connectorStatus || []) {
    out.push(new Paragraph({
      bullet: { level: 0 },
      children: [
        new TextRun({ text: `${c.system}: `, bold: true, size: 20 }),
        new TextRun({ text: c.available ? 'followed' : `not followed - ${c.reason}`, size: 20 }),
      ],
    }));
  }

  if (dossier.stats.truncated) {
    out.push(heading('Truncation', HeadingLevel.HEADING_2));
    out.push(body(`The page budget was reached at ${dossier.stats.pageCount} pages, so more material may exist. Raise MAX_PAGES to widen the sweep.`));
  }

  if (plan.openQuestions?.length) {
    out.push(heading('Open Questions', HeadingLevel.HEADING_2));
    for (const q of plan.openQuestions) {
      out.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: q, size: 20 })] }));
    }
  }

  if (plan.degraded) {
    out.push(heading('Note', HeadingLevel.HEADING_2));
    out.push(body(`Ordering is structural rather than narrative for this run (${plan.degradedReason}).`));
  }

  return out;
}

// --- helpers ----------------------------------------------------------------

function heading(text, level) {
  return new Paragraph({ text, heading: level, spacing: { before: 280, after: 140 } });
}

function body(text) {
  return new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text, size: 22 })] });
}

function linkRuns(text, url, size, bold) {
  if (!url) return [new TextRun({ text, size, bold })];
  return [
    new ExternalHyperlink({
      link: url,
      children: [new TextRun({ text, size, bold, style: 'Hyperlink' })],
    }),
  ];
}

function linkParagraph(text, url, size) {
  return new Paragraph({ children: linkRuns(text, url, size, false) });
}

function headerRow(labels) {
  return new TableRow({
    tableHeader: true,
    children: labels.map((label) =>
      new TableCell({
        shading: { type: ShadingType.CLEAR, fill: 'DEEAF6' },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 20 })] })],
      })
    ),
  });
}

function cell(children, widthPct) {
  return new TableCell({ width: { size: widthPct, type: WidthType.PERCENTAGE }, children });
}

function prettyType(type) {
  return {
    'confluence-page': 'Confluence page',
    'jira-issue': 'Jira issue',
    'github-repo': 'Repository',
    'github-pr': 'Pull request',
    'gitlab-project': 'GitLab project',
    'gitlab-mr': 'Merge request',
    'sharepoint-document': 'Document',
    'web-page': 'Web page',
  }[type] || type;
}
