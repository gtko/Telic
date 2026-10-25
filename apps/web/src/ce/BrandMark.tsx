'use client';

import TelicMark from '@/components/brand/TelicMark';

// The product mark at the top and the bottom of both sidebars. A self-hosted instance
// shows the core's; the hosted build can mark its edition on it.
export default function BrandMark({ className }: { className?: string }) {
  return <TelicMark className={className} />;
}
