export const PI_SUPPORTED_VERSION = '0.84.1' as const;
export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent' as const;
export const PI_INSTALL_COMMAND =
  `npm install -g --ignore-scripts ${PI_PACKAGE_NAME}@${PI_SUPPORTED_VERSION}` as const;
