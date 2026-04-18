'use client';

import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const OpsVisualizer = dynamic(() => import('../components/OpsVisualizer'), { ssr: false });

function EmbedInner() {
  const params = useSearchParams();
  const transparent = params.get('transparent') === 'true';
  return <OpsVisualizer transparent={transparent} />;
}

export default function EmbedPage() {
  return (
    <Suspense fallback={<div style={{ background: '#0a0a0a', width: '100vw', height: '100vh' }} />}>
      <EmbedInner />
    </Suspense>
  );
}
