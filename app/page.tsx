'use client';

import dynamic from 'next/dynamic';

const OpsVisualizer = dynamic(() => import('./components/OpsVisualizer'), { ssr: false });

export default function Home() {
  return <OpsVisualizer transparent={false} />;
}
