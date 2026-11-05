export class CloudStorageStore {
  constructor(bucket) {
    this.bucket = bucket;
  }

  async read(path) {
    try {
      const [data] = await this.bucket.file(path).download();
      return data;
    } catch (error) {
      if (error.code === 404) return null;
      throw error;
    }
  }

  async get(path) {
    try {
      const file = this.bucket.file(path);
      const [[data], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
      return { data, metadata };
    } catch (error) {
      if (error.code === 404) return null;
      throw error;
    }
  }

  async readJson(path) {
    const data = await this.read(path);
    return data === null ? null : JSON.parse(data.toString('utf8'));
  }

  async write(path, data, options = {}) {
    await this.bucket.file(path).save(data, {
      resumable: false,
      validation: 'crc32c',
      metadata: {
        contentType: options.contentType ?? 'application/octet-stream',
        cacheControl: options.cacheControl,
        contentDisposition: options.contentDisposition,
      },
      ...(options.ifGenerationMatch !== undefined
        ? { preconditionOpts: { ifGenerationMatch: options.ifGenerationMatch } }
        : {}),
    });
  }

  async metadata(path) {
    try {
      const [metadata] = await this.bucket.file(path).getMetadata();
      return metadata;
    } catch (error) {
      if (error.code === 404) return null;
      throw error;
    }
  }

  async delete(path, ifGenerationMatch) {
    try {
      await this.bucket.file(path).delete({
        ...(ifGenerationMatch !== undefined ? { preconditionOpts: { ifGenerationMatch } } : {}),
      });
    } catch (error) {
      if (error.code !== 404) throw error;
    }
  }
}
