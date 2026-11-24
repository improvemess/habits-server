/** An owner device, authenticated with its device token. May write. */
export interface DeviceAuth {
  kind: 'device';
  ownerId: string;
  deviceId: string;
}

/** A friend, authenticated with a reader token. Read-only, one share. */
export interface ReaderAuth {
  kind: 'reader';
  readerId: string;
  shareId: string;
}

export type Auth = DeviceAuth | ReaderAuth;
