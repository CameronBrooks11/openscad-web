'use strict';

const { TestEnvironment: PuppeteerEnvironment } = require('jest-environment-puppeteer');

class StablePuppeteerEnvironment extends PuppeteerEnvironment {
  async teardown() {
    try {
      await super.teardown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Protocol error: Connection closed')) return;
      throw error;
    }
  }
}

module.exports = StablePuppeteerEnvironment;
