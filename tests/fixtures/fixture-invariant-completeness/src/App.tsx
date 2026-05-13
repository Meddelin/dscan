// Mixed import paths to exercise barrel aliasing:
//   - `LegacyButton` via barrel (kit/index.ts → kit/LegacyButton.tsx)
//   - `LegacyButton` ALSO via direct file path (same profile, two pendings)
//   - `LegacyCard` via two-hop star re-export
//   - `DefaultCard` via renamed default import
import { LegacyButton, LegacyCard } from './kit';
import { LegacyButton as DirectButton } from './kit/LegacyButton';
import DefaultCard from './pages/DefaultExport';

export function App() {
  return (
    <div>
      <LegacyButton label="A" />
      <LegacyButton label="B" />
      <DirectButton label="C" />
      <LegacyCard title="One" />
      <LegacyCard title="Two" />
      <DefaultCard />
      <DefaultCard />
    </div>
  );
}
