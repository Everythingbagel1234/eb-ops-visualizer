import dynamic from 'next/dynamic';

const VoiceApp = dynamic(() => import('./VoiceApp'), { 
  ssr: false,
  loading: () => (
    <div style={{
      position: 'fixed', inset: 0, background: '#050510',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'rgba(245,158,11,0.5)', fontSize: 11, letterSpacing: '0.2em',
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      LOADING VOICE...
    </div>
  ),
});

export default function VoicePage() {
  return <VoiceApp />;
}
