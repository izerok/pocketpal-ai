import React from 'react';

import {fireEvent, render} from '../../../../jest/test-utils';

import {SettingsScreen} from '../SettingsScreen';
import {mockLocalApiServerStore} from '../../../../__mocks__/stores/localApiServerStore';

jest.useFakeTimers();

describe('SettingsScreen local API server', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLocalApiServerStore.running = false;
    mockLocalApiServerStore.lastError = null;
    mockLocalApiServerStore.requestsTotal = 0;
    mockLocalApiServerStore.requestsFailed = 0;
  });

  it('shows the local API server switch stopped', () => {
    const {getByTestId, getByText} = render(<SettingsScreen />, {
      withBottomSheetProvider: true,
      withNavigation: true,
    });
    expect(getByText('Local API Server')).toBeTruthy();
    expect(getByTestId('local-api-server-switch').props.value).toBe(false);
    expect(getByText('Stopped')).toBeTruthy();
    expect(getByText(/Port: 8080/)).toBeTruthy();
  });

  it('starts the server when the switch is turned on', async () => {
    const {getByTestId} = render(<SettingsScreen />, {
      withBottomSheetProvider: true,
      withNavigation: true,
    });
    fireEvent(getByTestId('local-api-server-switch'), 'onValueChange', true);
    await Promise.resolve();
    expect(mockLocalApiServerStore.start).toHaveBeenCalled();
  });

  it('shows the base URL while running', () => {
    mockLocalApiServerStore.running = true;
    const {getByText} = render(<SettingsScreen />, {
      withBottomSheetProvider: true,
      withNavigation: true,
    });
    expect(getByText('Running at http://192.168.1.42:8080')).toBeTruthy();
  });
});
