import type { Logging } from 'homebridge';
import axios, { AxiosInstance } from 'axios';
import { Mutex } from 'async-mutex';
import crypto from 'crypto';
import qs from 'qs';

import { BatteryLevel, Lock, LockDetails, LockIdList, LockState, NfcCardList, PasscodeList } from '../types';

class RequestFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestFailed';
  }
}

export class TTLockApi {
  private apiClient: AxiosInstance;
  public accessToken: string | null = null;
  public refreshToken: string | null = null;
  private tokenMutex = new Mutex();
  private requestQueue: (() => Promise<void>)[] = [];
  private isProcessingQueue = false;

  constructor(private log: Logging, private clientId: string, private clientSecret: string) {
    this.apiClient = axios.create({
      baseURL: 'https://euapi.ttlock.com/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  }

  private encryptPassword(password: string): string {
    return crypto.createHash('md5').update(password).digest('hex');
  }

  public async authenticate(username: string, password: string): Promise<void> {
    try {
      const encryptedPassword = this.encryptPassword(password);
      const response = await this.apiClient.post('oauth2/token', qs.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'password',
        username,
        password: encryptedPassword,
      }));

      if (response.data.access_token && response.data.refresh_token) {
        this.accessToken = response.data.access_token;
        this.refreshToken = response.data.refresh_token;
      } else {
        this.log.error('Authentication response did not contain tokens:', response.data);
        throw new Error('Authentication failed: No tokens received');
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.log.error('Failed to authenticate with TTLock API:', error.response?.data || error.message);
      } else {
        this.log.error('Failed to authenticate with TTLock API:', error);
      }
      throw error;
    }
  }

  private async refreshTokenIfNeeded(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available. Please call authenticate() first.');
    }

    const release = await this.tokenMutex.acquire();
    try {
      const response = await this.apiClient.post('oauth2/token', qs.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }));

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
    } finally {
      release();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      return;
    }
    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      if (request) {
        try {
          await request();
        } catch (error) {
          this.log.error('Error processing request:', error);
        }
      }
    }

    this.isProcessingQueue = false;
  }

  private enqueueRequest(request: () => Promise<void>): void {
    this.requestQueue.push(request);
    this.processQueue();
  }

  private async makeAuthenticatedRequest<T>(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.enqueueRequest(async () => {
        const maxRetries = 3;
        if (!this.accessToken) {
          throw new Error('Not authenticated. Please call authenticate() first.');
        }

        const requestData = {
          ...data,
          clientId: this.clientId,
          accessToken: this.accessToken,
          date: Date.now(),
        };

        const fullEndpoint = `v3/${endpoint}`;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const response = await this.apiClient.request({
              url: fullEndpoint,
              method,
              headers: {
                Authorization: `Bearer ${this.accessToken}`,
              },
              params: method === 'GET' ? requestData : undefined,
              data: method === 'POST' ? qs.stringify(requestData) : undefined,
            });

            if (response.data.errcode && response.data.errcode !== 0) {
              this.log.error(`API returned error: ${response.data.errmsg}`);
              throw new RequestFailed(`API returned: ${response.data.errmsg}`);
            }

            resolve(response.data);
            return;
          } catch (error: unknown) {
            if (axios.isAxiosError(error) && error.response) {
              if (error.response.status === 401) {
                this.log.warn('Access token expired, refreshing token...');
                await this.refreshTokenIfNeeded();
                continue;
              }
              if (error.response.data.errmsg === 'The gateway is busy. Please try again later.') {
                this.log.warn(`Attempt ${attempt + 1} failed: ${error.response.data.errmsg}`);
                if (attempt < maxRetries) {
                  const delay = Math.pow(2, attempt) * 1000;
                  this.log.warn(`Retrying in ${delay / 1000} seconds...`);
                  await new Promise(resolve => setTimeout(resolve, delay));
                  continue;
                }
              }
              this.log.error(`Request failed: status=${error.response.status}, body=${JSON.stringify(error.response.data)}`);
              reject(new RequestFailed(`Request failed: status=${error.response.status}, body=${error.response.data}`));
              return;
            }
            if (error instanceof Error) {
              this.log.error(`Request failed: ${error.message}`);
            } else {
              this.log.error(`Request failed: ${JSON.stringify(error)}`);
            }
            reject(error);
            return;
          }
        }
        reject(new Error('Max retries reached'));
      });
    });
  }

  public async getLocks(): Promise<LockIdList> {
    const response = await this.makeAuthenticatedRequest<{
      list: { lockId: string }[];
      pageNo: number;
      pageSize: number;
      pages: number;
      total: number;
    }>('lock/list', 'GET', { pageNo: 1, pageSize: 1000 });

    if (!response.list || !Array.isArray(response.list)) {
      throw new Error('Invalid response format: expected list of locks');
    }

    return response.list.map((item) => ({
      lockId: item.lockId.toString(),
    }));
  }

  public async getLockDetails(lockId: string): Promise<LockDetails> {
    const data = await this.makeAuthenticatedRequest<LockDetails>('lock/detail', 'GET', { lockId });
    return {
      lockId: data.lockId.toString(),
      lockAlias: data.lockAlias,
      lockMac: data.lockMac,
      modelNum: data.modelNum,
      hardwareRevision: data.hardwareRevision,
      firmwareRevision: data.firmwareRevision,
    };
  }

  public async getLockState(lockId: string): Promise<LockState> {
    const data = await this.makeAuthenticatedRequest<LockState>('lock/queryOpenState', 'GET', { lockId });
    return {
      state: data.state,
    };
  }

  public async mapToLock(
    lockDetails: LockDetails,
    lockState: LockState,
    lockBattery: BatteryLevel,
    lockPasscodes: PasscodeList,
    lockNfcCards: NfcCardList,
  ): Promise<Lock> {
    return {
      id: lockDetails.lockId.toString(),
      alias: lockDetails.lockAlias,
      mac: lockDetails.lockMac,
      model: lockDetails.modelNum,
      hardwareRevision: lockDetails.hardwareRevision,
      firmwareRevision: lockDetails.firmwareRevision,
      state: lockState.state,
      battery: lockBattery.battery,
      passCodes: lockPasscodes,
      nfcCards: lockNfcCards,
    };
  }

  public async lock(lockId: string): Promise<void> {
    return this.makeAuthenticatedRequest('lock/lock', 'POST', { lockId });
  }

  public async unlock(lockId: string): Promise<void> {
    return this.makeAuthenticatedRequest('lock/unlock', 'POST', { lockId });
  }

  public async getBatteryLevel(lockId: string): Promise<BatteryLevel> {
    const data = await this.makeAuthenticatedRequest<{ electricQuantity: number }>('lock/queryElectricQuantity', 'GET', { lockId });
    return {
      battery: data.electricQuantity,
    };
  }

  public async getPasscodes(lockId: string): Promise<PasscodeList> {
    const response = await this.makeAuthenticatedRequest<{
      list: {
        keyboardPwdId: string;
        lockId: string;
        keyboardPwd: string;
      }[];
      pageNo: number;
      pageSize: number;
      pages: number;
      total: number;
    }>('lock/listKeyboardPwd', 'GET', { lockId, pageNo: 1, pageSize: 1000, orderBy: 0 });

    if (!response.list || !Array.isArray(response.list)) {
      throw new Error('Invalid response format: expected list of passcodes');
    }

    return response.list.map((item, index) => ({
      id: item.keyboardPwdId.toString(),
      index: (index).toString(),
      lockId: item.lockId.toString(),
      passcode: item.keyboardPwd,
    }));
  }

  public async addPasscode(lockId: string, passcode: string): Promise<{ keyboardPwdId: string }> {
    return this.makeAuthenticatedRequest('keyboardPwd/add', 'POST', {
      lockId,
      keyboardPwd: passcode,
      keyboardPwdType: 2,
      addType: 2,
    });
  }

  public async changePasscode(lockId: string, passcodeId: string, passcode: string): Promise<void> {
    return this.makeAuthenticatedRequest('keyboardPwd/change', 'POST', {
      lockId,
      keyboardPwdId: passcodeId,
      newKeyboardPwd: passcode,
      changeType: 2,
    });
  }

  public async deletePasscode(lockId: string, passcodeId: string): Promise<void> {
    return this.makeAuthenticatedRequest('keyboardPwd/delete', 'POST', {
      lockId,
      keyboardPwdId: passcodeId,
      deleteType: 2,
    });
  }

  public async getNfcCards(lockId: string): Promise<NfcCardList> {
    const response = await this.makeAuthenticatedRequest<{
      list: {
        cardId: string;
        lockId: string;
        cardNumber: string;
      }[];
      pageNo: number;
      pageSize: number;
      pages: number;
      total: number;
    }>('identityCard/list', 'GET', { lockId, pageNo: 1, pageSize: 1000, orderBy: 0 });

    if (!response.list || !Array.isArray(response.list)) {
      throw new Error('Invalid response format: expected list of NFC cards');
    }

    return response.list.map((item) => ({
      id: item.cardId.toString(),
      lockId: item.lockId.toString(),
      number: item.cardNumber,
    }));
  }

  public async addNfcCard(lockId: string, cardNumber: string): Promise<{ cardId: string }> {
    return this.makeAuthenticatedRequest('identityCard/addForReversedCardNumber', 'POST', {
      lockId,
      cardNumber,
      startDate: 0,
      endDate: 0,
      addType: 2,
    });
  }

  public async deleteNfcCard(lockId: string, cardId: string): Promise<void> {
    return this.makeAuthenticatedRequest('card/delete', 'POST', {
      lockId,
      cardId,
      deleteType: 2,
    });
  }
}