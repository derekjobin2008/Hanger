// Turns a spoken maintenance note into structured FAA log entry fields.
//
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise falls back to a plain
// regex pass so the app still runs (and demos) with no key.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-8';

const SYSTEM = `You convert a mechanic's spoken shorthand into the fields of a maintenance record entry under 14 CFR 43.9.

Rules:
- "description" is the description of work performed. Write it the way an A&P writes a logbook entry: past tense, third person, specific, no filler. Include torque values, quantities, part numbers, and inspection references that the mechanic mentioned. Do not invent any detail the mechanic did not say.
- If the mechanic described a problem and a fix, put the problem in "discrepancy" and the fix in "description". If they only described work, leave "discrepancy" empty.
- "tail_number" is the aircraft registration, normalized to uppercase with no spaces or hyphens (e.g. "november one two three alpha bravo" -> "N123AB").
- "parts" lists each part installed or replaced. Leave "part_number" or "quantity" empty if not stated.
- "tach_time" / "hobbs_time" only if the mechanic said a tach or Hobbs reading. Numbers only.
- "date_completed" in YYYY-MM-DD. If no date was spoken, use the provided today's date.
- "return_to_service" is true only if the mechanic clearly said the aircraft is approved for return to service.
- Leave any field empty ("") when the mechanic did not say it. Never guess. Never pad.`;

const SCHEMA = {
  type: 'object',
  properties: {
    tail_number: { type: 'string', description: 'Aircraft registration, e.g. N123AB. Empty if not stated.' },
    aircraft: { type: 'string', description: 'Make and model if stated, e.g. "Cessna 172S". Empty otherwise.' },
    date_completed: { type: 'string', description: 'YYYY-MM-DD' },
    tach_time: { type: 'string', description: 'Tach reading, numbers only. Empty if not stated.' },
    hobbs_time: { type: 'string', description: 'Hobbs reading, numbers only. Empty if not stated.' },
    discrepancy: { type: 'string', description: 'The reported problem, if one was described. Empty otherwise.' },
    description: { type: 'string', description: 'Description of work performed, in logbook prose.' },
    parts: {
      type: 'array',
      description: 'Parts installed or replaced.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          part_number: { type: 'string' },
          quantity: { type: 'string' },
        },
        required: ['name', 'part_number', 'quantity'],
        additionalProperties: false,
      },
    },
    return_to_service: { type: 'boolean' },
    needs_review: {
      type: 'array',
      description: 'Field names the mechanic left out that a compliant entry normally needs.',
      items: { type: 'string' },
    },
  },
  required: [
    'tail_number', 'aircraft', 'date_completed', 'tach_time', 'hobbs_time',
    'discrepancy', 'description', 'parts', 'return_to_service', 'needs_review',
  ],
  additionalProperties: false,
};

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export const usingClaude = Boolean(client);

export async function parseTranscript(transcript, today) {
  if (!client) return fallbackParse(transcript, today);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: `Today's date is ${today}.\n\nMechanic said:\n"""${transcript}"""`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  return normalize(JSON.parse(text), today);
}

// ---------------------------------------------------------------------------
// No-key fallback. Crude on purpose — it exists so the app runs without a key.

const PHONETIC = {
  alpha: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F',
  golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J', kilo: 'K',
  lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q',
  romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U', victor: 'V', whiskey: 'W',
  xray: 'X', 'x-ray': 'X', yankee: 'Y', zulu: 'Z',
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', niner: '9', nine: '9',
};

function fallbackParse(transcript, today) {
  const words = transcript.toLowerCase().split(/[\s,]+/);

  let tail = (transcript.match(/\bN\d[\dA-Za-z]{1,5}\b/) || [''])[0].toUpperCase();
  if (!tail) {
    // Stitch together a run of phonetic words starting at "november".
    const start = words.indexOf('november');
    if (start !== -1) {
      let out = '';
      for (const w of words.slice(start)) {
        const c = PHONETIC[w.replace(/[^a-z-]/g, '')];
        if (c === undefined) break;
        out += c;
      }
      if (out.length >= 4) tail = out;
    }
  }

  const tach = (transcript.match(/\btach(?:ometer)?\s*(?:time|reading)?\s*(?:is|at|of)?\s*([\d.]+)/i) || ['', ''])[1];
  const hobbs = (transcript.match(/\bhobbs\s*(?:time|reading)?\s*(?:is|at|of)?\s*([\d.]+)/i) || ['', ''])[1];

  return normalize({
    tail_number: tail,
    aircraft: '',
    date_completed: today,
    tach_time: tach,
    hobbs_time: hobbs,
    discrepancy: '',
    description: transcript.trim(),
    parts: [],
    return_to_service: false,
    needs_review: ['description', ...(tail ? [] : ['tail_number'])],
  }, today);
}

// ---------------------------------------------------------------------------

function normalize(raw, today) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    tail_number: str(raw.tail_number).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    aircraft: str(raw.aircraft),
    date_completed: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.date_completed)) ? raw.date_completed : today,
    tach_time: str(raw.tach_time),
    hobbs_time: str(raw.hobbs_time),
    discrepancy: str(raw.discrepancy),
    description: str(raw.description),
    parts: Array.isArray(raw.parts)
      ? raw.parts.map((p) => ({
          name: str(p?.name),
          part_number: str(p?.part_number),
          quantity: str(p?.quantity),
        })).filter((p) => p.name)
      : [],
    return_to_service: raw.return_to_service === true,
    needs_review: Array.isArray(raw.needs_review) ? raw.needs_review.map(str).filter(Boolean) : [],
  };
}

// Assembles the fields into the block of text that goes in the logbook.
export function renderEntry(e) {
  const lines = [];
  lines.push(`${e.date_completed}${e.tail_number ? `    ${e.tail_number}` : ''}${e.aircraft ? `    ${e.aircraft}` : ''}`);

  const times = [];
  if (e.tach_time) times.push(`Tach: ${e.tach_time}`);
  if (e.hobbs_time) times.push(`Hobbs: ${e.hobbs_time}`);
  if (times.length) lines.push(times.join('    '));

  lines.push('');
  if (e.discrepancy) lines.push(`DISCREPANCY: ${e.discrepancy}`, '');
  lines.push(e.description);

  const parts = JSON.parse(e.parts_json || '[]');
  if (parts.length) {
    lines.push('', 'PARTS:');
    for (const p of parts) {
      const bits = [p.name];
      if (p.part_number) bits.push(`P/N ${p.part_number}`);
      if (p.quantity) bits.push(`Qty ${p.quantity}`);
      lines.push(`  - ${bits.join(', ')}`);
    }
  }

  if (e.return_to_service) {
    lines.push('', 'I certify that this aircraft has been inspected and/or repaired in accordance with');
    lines.push('current Federal Aviation Regulations and is approved for return to service.');
  }

  lines.push('');
  lines.push(`${e.mechanic_name || '________________________'}    ${e.cert_type || 'A&P'} ${e.cert_number || '____________'}`);
  lines.push(e.signed ? `Signed ${e.signed_at}` : 'UNSIGNED — signature required before this entry is valid.');

  return lines.join('\n');
}
