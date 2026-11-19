import '@cmdless/ui-sdk/browser'; // window.cmdless's type
import '@mantine/core/styles.css';
import './view.css';
import './fit.ts'; // the window fits what's shown
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type { ViewProps } from '@cmdless/ui-sdk';

// each view loads only what it needs: a card's renderer, or a form's
const Card = lazy(() => import('./Card.tsx'));
const Form = lazy(() => import('./Form.tsx'));

const props: ViewProps = await window.cmdless.view.request.props();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <Suspense>
        {props.view === 'card' ? <Card {...props} /> : <Form {...props} />}
      </Suspense>
    </MantineProvider>
  </StrictMode>,
);
