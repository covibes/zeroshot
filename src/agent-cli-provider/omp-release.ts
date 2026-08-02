export const OMP_SUPPORTED_VERSION = '17.2.1' as const;
export const OMP_PACKAGE_NAME = '@oh-my-pi/pi-coding-agent' as const;
export const OMP_BINARY_NAME = 'omp' as const;
export const OMP_INSTALL_COMMAND =
  `npm install -g --ignore-scripts ${OMP_PACKAGE_NAME}@${OMP_SUPPORTED_VERSION}` as const;
export const OMP_RELEASE_DOWNLOAD_BASE_URL =
  `https://github.com/can1357/oh-my-pi/releases/download/v${OMP_SUPPORTED_VERSION}` as const;

export type OmpReleasePlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-musl-arm64'
  | 'linux-musl-x64'
  | 'linux-x64';

export interface OmpReleaseAsset {
  readonly name: string;
  readonly platform: OmpReleasePlatform;
  readonly sha256: string;
}

// Verified via `gh api repos/can1357/oh-my-pi/releases/tags/v17.2.1`. Windows is excluded (Unix-only).
export const OMP_RELEASE_ASSETS: readonly OmpReleaseAsset[] = [
  {
    name: 'omp-darwin-arm64',
    platform: 'darwin-arm64',
    sha256: 'b75eddb19ba9ec401fee5ecb35b3ceb5ddc48708e98b5a113136df5d65f2bed8',
  },
  {
    name: 'omp-darwin-x64',
    platform: 'darwin-x64',
    sha256: 'd23c197d93243122ef9a35a247bdd85075c4c1356dd1fa4a080faaa2dae4b905',
  },
  {
    name: 'omp-linux-arm64',
    platform: 'linux-arm64',
    sha256: 'd34883744bb54476f7268aad4b561ea9b1cd826f201d044b337c5a96713fa83d',
  },
  {
    name: 'omp-linux-musl-arm64',
    platform: 'linux-musl-arm64',
    sha256: '3babfe15664f32fcc03dc91d92a10341baf6e65b9868351de21c5aa3218e139d',
  },
  {
    name: 'omp-linux-musl-x64',
    platform: 'linux-musl-x64',
    sha256: '8f05f7eed2940b11c29d7aaf0e641b100c014db5bfbee00afa5dd4929ad5dd6a',
  },
  {
    name: 'omp-linux-x64',
    platform: 'linux-x64',
    sha256: 'ac0285a571aa79c58d59482561a3871befe7333dba3a3bdc2e90682653ee33b2',
  },
];

export function findOmpReleaseAsset(platform: string): OmpReleaseAsset | undefined {
  return OMP_RELEASE_ASSETS.find((asset) => asset.platform === platform);
}

export function ompReleaseAssetDownloadUrl(asset: OmpReleaseAsset): string {
  return `${OMP_RELEASE_DOWNLOAD_BASE_URL}/${asset.name}`;
}
