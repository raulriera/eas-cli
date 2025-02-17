import { AppJSONConfig, PackageJSONConfig, Platform, getConfig } from '@expo/config';
import { Updates } from '@expo/config-plugins';
import { vol } from 'memfs';
import path from 'path';
import { instance, mock } from 'ts-mockito';

import UpdatePublish from '..';
import { ensureBranchExistsAsync } from '../../../branch/queries';
import { DynamicProjectConfigContextField } from '../../../commandUtils/context/DynamicProjectConfigContextField';
import LoggedInContextField from '../../../commandUtils/context/LoggedInContextField';
import { ExpoGraphqlClient } from '../../../commandUtils/context/contextUtils/createGraphqlClient';
import FeatureGateEnvOverrides from '../../../commandUtils/gating/FeatureGateEnvOverrides';
import FeatureGating from '../../../commandUtils/gating/FeatureGating';
import { jester } from '../../../credentials/__tests__/fixtures-constants';
import { UpdateFragment } from '../../../graphql/generated';
import { PublishMutation } from '../../../graphql/mutations/PublishMutation';
import { AppQuery } from '../../../graphql/queries/AppQuery';
import { collectAssetsAsync, uploadAssetsAsync } from '../../../project/publish';
import { getBranchNameFromChannelNameAsync } from '../../../update/getBranchNameFromChannelNameAsync';

const projectRoot = '/test-project';
const commandOptions = { root: projectRoot } as any;
const updateStub: UpdateFragment = {
  id: 'update-1234',
  group: 'group-1234',
  branch: { id: 'branch-1234', name: 'main' },
  message: 'test message',
  runtimeVersion: 'exposdk:47.0.0',
  platform: 'ios',
  gitCommitHash: 'commit',
  manifestFragment: JSON.stringify({ fake: 'manifest' }),
  manifestPermalink: 'https://expo.dev/fake/manifest/link',
  codeSigningInfo: null,
  createdAt: '2022-01-01T12:00:00Z',
};

jest.mock('fs');
jest.mock('@expo/config');
jest.mock('@expo/config-plugins');
jest.mock('../../../branch/queries');
jest.mock('../../../commandUtils/context/contextUtils/getProjectIdAsync');
jest.mock('../../../update/configure');
jest.mock('../../../update/getBranchNameFromChannelNameAsync');
jest.mock('../../../graphql/mutations/PublishMutation');
jest.mock('../../../graphql/queries/AppQuery');
jest.mock('../../../graphql/queries/UpdateQuery');
jest.mock('../../../ora', () => ({
  ora: () => ({
    start: () => ({ succeed: () => {}, fail: () => {} }),
  }),
}));
jest.mock('../../../project/publish', () => ({
  ...jest.requireActual('../../../project/publish'),
  buildBundlesAsync: jest.fn(),
  collectAssetsAsync: jest.fn(),
  resolveInputDirectoryAsync: jest.fn((inputDir = 'dist') => path.join(projectRoot, inputDir)),
  uploadAssetsAsync: jest.fn(),
}));

describe(UpdatePublish.name, () => {
  afterEach(() => vol.reset());

  // Deprecated and split to a new command: update:republish
  it('errors with --republish', async () => {
    await expect(new UpdatePublish(['--republish'], commandOptions).run()).rejects.toThrow(
      '--group and --republish flags are deprecated'
    );
  });

  // Deprecated and split to a new command: update:republish
  it('errors with --group', async () => {
    await expect(new UpdatePublish(['--group=abc123'], commandOptions).run()).rejects.toThrow(
      '--group and --republish flags are deprecated'
    );
  });

  it('errors with both --channel and --branch', async () => {
    const flags = ['--channel=channel123', '--branch=branch123'];

    mockTestProject();

    await expect(new UpdatePublish(flags, commandOptions).run()).rejects.toThrow(
      'Cannot specify both --channel and --branch. Specify either --channel, --branch, or --auto'
    );
  });

  it('creates a new update with --non-interactive, --branch, and --message', async () => {
    const flags = ['--non-interactive', '--branch=branch123', '--message=abc'];

    mockTestProject();
    const { platforms, runtimeVersion } = mockTestExport();

    jest.mocked(ensureBranchExistsAsync).mockResolvedValue({
      branchId: 'branch123',
      createdBranch: false,
    });

    jest
      .mocked(PublishMutation.publishUpdateGroupAsync)
      .mockResolvedValue(platforms.map(platform => ({ ...updateStub, platform, runtimeVersion })));

    await new UpdatePublish(flags, commandOptions).run();

    expect(PublishMutation.publishUpdateGroupAsync).toHaveBeenCalled();
  });

  it('creates a new update with --non-interactive, --channel, and --message', async () => {
    const flags = ['--non-interactive', '--channel=channel123', '--message=abc'];

    const { projectId } = mockTestProject();
    const { platforms, runtimeVersion } = mockTestExport();

    jest.mocked(getBranchNameFromChannelNameAsync).mockResolvedValue('branchFromChannel');
    jest.mocked(ensureBranchExistsAsync).mockResolvedValue({
      branchId: 'branch123',
      createdBranch: false,
    });

    jest.mocked(PublishMutation.publishUpdateGroupAsync).mockResolvedValue(
      platforms.map(platform => ({
        ...updateStub,
        runtimeVersion,
        platform,
      }))
    );

    await new UpdatePublish(flags, commandOptions).run();

    expect(ensureBranchExistsAsync).toHaveBeenCalledWith(
      expect.any(Object), // graphql client
      {
        appId: projectId,
        branchName: 'branchFromChannel',
      }
    );

    expect(PublishMutation.publishUpdateGroupAsync).toHaveBeenCalled();
  });
});

/** Create a new in-memory project, copied from src/commands/update/__tests__/republish.test.ts */
function mockTestProject({
  configuredProjectId = '1234',
}: {
  configuredProjectId?: string;
} = {}): { projectId: string } {
  const packageJSON: PackageJSONConfig = {
    name: 'testing123',
    version: '0.1.0',
    description: 'fake description',
    main: 'index.js',
  };

  const appJSON: AppJSONConfig = {
    expo: {
      name: 'testing 123',
      version: '0.1.0',
      slug: 'testing-123',
      sdkVersion: '33.0.0',
      owner: jester.accounts[0].name,
      extra: {
        eas: {
          projectId: configuredProjectId,
        },
      },
    },
  };

  vol.fromJSON(
    {
      'package.json': JSON.stringify(packageJSON),
      'app.json': JSON.stringify(appJSON),
    },
    projectRoot
  );

  const mockManifest = { exp: appJSON.expo };
  const graphqlClient = instance(mock<ExpoGraphqlClient>({}));

  jest.mocked(getConfig).mockReturnValue(mockManifest as any);
  jest
    .spyOn(DynamicProjectConfigContextField.prototype, 'getValueAsync')
    .mockResolvedValue(async () => ({
      exp: mockManifest.exp,
      projectDir: projectRoot,
      projectId: configuredProjectId,
    }));

  jest.spyOn(LoggedInContextField.prototype, 'getValueAsync').mockResolvedValue({
    actor: jester,
    featureGating: new FeatureGating({}, new FeatureGateEnvOverrides()),
    graphqlClient,
  });

  jest.mocked(AppQuery.byIdAsync).mockResolvedValue({
    id: '1234',
    slug: 'testing-123',
    fullName: '@jester/testing-123',
    ownerAccount: jester.accounts[0],
  });

  return { projectId: configuredProjectId };
}

/** Create a new in-memory export of the project */
function mockTestExport({
  exportDir = 'dist',
  platforms = ['android', 'ios'],
  runtimeVersion = 'exposdk:47.0.0',
}: {
  exportDir?: string;
  platforms?: Platform[];
  runtimeVersion?: string;
} = {}): {
  inputDir: string;
  platforms: Platform[];
  runtimeVersion: string;
} {
  /* eslint-disable node/no-sync */
  vol.mkdirpSync(path.join(projectRoot, exportDir, 'bundles'));
  for (const platform of platforms) {
    vol.writeFileSync(
      path.join(projectRoot, exportDir, 'bundles', `${platform}-fake.js`),
      `console.log("fake bundle for ${platform}");`
    );
  }

  jest.mocked(collectAssetsAsync).mockResolvedValue(
    Object.fromEntries(
      platforms.map(platform => [
        platform,
        {
          assets: [],
          launchAsset: {
            contentType: 'application/javascript',
            path: path.join(projectRoot, exportDir, 'bundles', `${platform}-fake.js`),
          },
        },
      ])
    )
  );

  jest.mocked(uploadAssetsAsync).mockResolvedValue({
    // platforms are mocked all containing only the launch asset
    assetCount: platforms.length,
    uniqueAssetCount: platforms.length,
    uniqueUploadedAssetCount: platforms.length,
    assetLimitPerUpdateGroup: 9001,
  });

  jest.mocked(Updates.getRuntimeVersion).mockReturnValue(runtimeVersion);

  return { inputDir: exportDir, platforms, runtimeVersion };
}
