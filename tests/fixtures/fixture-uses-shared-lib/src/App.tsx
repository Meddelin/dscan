// Consumer doesn't declare any local libraries. The shared kit is recognised
// because the operator listed it in GlobalConfig.sharedLibraries.
import { TeamButton, LegacyDropdown } from '@team/platform';

export function App() {
  return (
    <div>
      <TeamButton label="Save" />
      <LegacyDropdown />
    </div>
  );
}
