import { useEffect, useRef, useState } from 'react';
import * as AC from 'adaptivecards';
import { useComputedColorScheme } from '@mantine/core';
import type { types } from '@cmdless/ui-sdk';

type AdaptiveCard = types.AdaptiveCard;
import { defaultHostConfig } from './hostConfig.ts';
import { renderMarkdown } from './markdown.ts';
import { reportHeight } from './fit.ts';

AC.AdaptiveCard.onProcessMarkdown = (text, result) => {
  result.outputHtml = renderMarkdown(text);
  result.didProcess = true;
};

// what's been typed into a card's inputs, by id
type Inputs = Record<string, unknown>;

// a new card, with each input that has the same id as one on the card it
// replaces keeping what was typed into it
function carryInputs(card: AdaptiveCard, inputs: Inputs): AdaptiveCard {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const copy: Record<string, unknown> = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, visit(value)]));
    if (typeof copy.type === 'string' && copy.type.startsWith('Input.') && typeof copy.id === 'string' && copy.id in inputs)
      copy.value = inputs[copy.id];
    return copy;
  };
  return visit(card) as AdaptiveCard;
}

const inputsOf = (card: AC.AdaptiveCard): Inputs =>
  Object.fromEntries(card.getAllInputs().filter(input => input.id).map(input => [input.id!, input.value]));

// an Adaptive Card, drawn by Microsoft's renderer. Submit ends the card with
// what was chosen; Execute goes to the card's UIHost as an event; links open
// in the browser; the rest (showing a card, toggling visibility) the renderer
// does itself.
export default function Card({ card: initial, hostConfig }: types.CardView) {
  const root = useRef<HTMLDivElement>(null);
  const rendered = useRef<AC.AdaptiveCard>(null);
  const [card, setCard] = useState(initial);
  const scheme = useComputedColorScheme('light');

  // a new card keeps what's been typed into the one it replaces
  useEffect(() => {
    const listening = window.cmdless.view.onNotification.update(({ card }) => {
      setCard(rendered.current ? carryInputs(card, inputsOf(rendered.current)) : card);
    });
    return () => listening?.dispose?.();
  }, []);

  useEffect(() => {
    let current = true;
    void draw().catch(error => console.error('couldn\'t draw the card', error));
    return () => { current = false; };

    async function draw() {
      // a JSON Schema form in the card brings its form library with it - only
      // then, so other cards stay light
      if (JSON.stringify(card).includes('"Input.JsonSchema"')) await import('./SchemaInput.tsx');
      if (!current) return;
      const adaptive = new AC.AdaptiveCard();
      adaptive.hostConfig = new AC.HostConfig(hostConfig ?? defaultHostConfig(scheme));
      adaptive.onExecuteAction = action => {
        if (action instanceof AC.OpenUrlAction) {
          if (action.url) window.open(action.url);
          return;
        }
        const chosen = { action: action.toJSON() as never, inputs: inputsOf(adaptive) };
        // Submit is the card's answer, and ends it; Execute is something to
        // act on while it stays up (and perhaps shows another card)
        if (action instanceof AC.SubmitAction) window.cmdless.view.notify.close({ value: chosen });
        else if (action instanceof AC.ExecuteAction) window.cmdless.view.notify.event(chosen);
      };
      // a scheme change redraws the card: keep what's been typed
      const shown = rendered.current ? carryInputs(card, inputsOf(rendered.current)) : card;
      adaptive.parse(shown);
      const element = adaptive.render();
      root.current?.replaceChildren(...(element ? [element] : []));
      rendered.current = adaptive;
      reportHeight();
    }
  }, [card, hostConfig, scheme]);

  return <div ref={root} className="card" />;
}
