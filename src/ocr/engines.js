/**
 * The engines, and which one gets a given document.
 *
 * The original sent every file to a hosted model. This tries the text layer
 * first, and that is the one design decision in this project worth arguing for.
 *
 * A PDF written by a word processor, a browser, an accounting package or a
 * label printer **already contains its text**. Rendering it to pixels and
 * recognising them gives a worse answer than the one that was already in the
 * file, takes a second or two longer, and costs money per page. Most of what
 * arrives at a service like this is that kind of PDF. So: read the layer, and
 * fall through to the expensive engine only for the documents that genuinely
 * need it — a scan, a photograph, a fax.
 *
 * The other thing it buys is that the service runs with no account anywhere.
 * Somebody can clone this, start it, and put real documents through it without
 * signing up for anything, and the part that needs a key announces itself when
 * it is needed rather than at startup.
 */

import { readPdfText } from './pdf-text.js';
import { mistralEngine } from './mistral.js';

/**
 * @typedef {object} Engine
 * @property {string} name
 * @property {string} needs        what it must be given to work at all
 * @property {(file: {buffer: Buffer, mimetype: string}) => boolean} canTry
 * @property {(file: object, ctx: object) => Promise<{text: string, why: string}>} read
 */

export function engineRegistry({ mistral = {}, log = () => {} } = {}) {
  /** @type {Engine[]} */
  const engines = [
    {
      name: 'text-layer',
      needs: 'nothing',
      canTry: (file) => file.mimetype === 'application/pdf',
      async read(file, { onProgress }) {
        onProgress?.(0.4, 'reading the text layer');
        const found = readPdfText(file.buffer);
        onProgress?.(0.9, found.why);

        if (!found.text.trim()) {
          const nothing = new Error(found.why);
          nothing.code = 'NO_TEXT_LAYER';
          throw nothing;
        }

        return {
          text: found.text,
          why: found.why,
          pages: found.pages.length,
          fonts: found.fonts,
        };
      },
    },

    mistralEngine({ ...mistral, log }),
  ];

  return {
    all: () => engines.map(({ name, needs }) => ({ name, needs })),

    /**
     * Runs the engines in order until one produces text.
     *
     * An engine declining is not an error and is not silent: what each one said
     * travels back with the result, so a caller who gets no text can see that
     * the file had no text layer AND that no engine able to read pixels was
     * configured — rather than an empty string that could mean either.
     */
    async read(file, { onProgress = () => {}, only = null } = {}) {
      const tried = [];
      const usable = engines.filter((engine) => (only ? engine.name === only : true));

      if (usable.length === 0) {
        const unknown = new Error(`there is no engine called "${only}"`);
        unknown.status = 400;
        throw unknown;
      }

      for (const engine of usable) {
        if (!engine.canTry(file)) {
          tried.push({ engine: engine.name, outcome: 'not for this kind of file' });
          continue;
        }

        try {
          onProgress(0.1, `trying ${engine.name}`);
          const got = await engine.read(file, { onProgress });
          return { ...got, engine: engine.name, tried: [...tried, { engine: engine.name, outcome: 'read it' }] };
        } catch (error) {
          tried.push({ engine: engine.name, outcome: error.message });
          log('info', 'engine declined', { engine: engine.name, why: error.message });

          // A configuration problem or a refusal means try the next engine. A
          // fault in an engine that COULD have worked is a fault, and hiding it
          // behind "nothing could read this" is how an outage goes unnoticed
          // for a week.
          if (error.code !== 'NO_TEXT_LAYER' && error.code !== 'ENGINE_NOT_CONFIGURED') throw error;
        }
      }

      const nothing = new Error('no engine could read this document');
      nothing.status = 422;
      nothing.tried = tried;
      throw nothing;
    },
  };
}
