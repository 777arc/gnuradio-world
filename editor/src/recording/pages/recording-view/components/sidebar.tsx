// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

import React from 'react';
import SettingsPane from './settings-pane';
import { Tab } from '../tabs';

interface SidebarProps {
  currentFFT: number;
  currentTab: Tab;
  setCurrentTab: (tab: Tab) => void;
}

const Sidebar = ({ currentFFT, currentTab, setCurrentTab }: SidebarProps) => {
  return (
    <div className="flex flex-col w-64 ml-3">
      <details open>
        <summary className="pl-2 bg-primary outline outline-1 outline-primary text-lg text-base-100 hover:bg-green-800">
          Settings
        </summary>
        <div className="outline outline-1 outline-primary p-2">
          <SettingsPane currentFFT={currentFFT} currentTab={currentTab} setCurrentTab={setCurrentTab} />
        </div>
      </details>
    </div>
  );
};

export { Sidebar };
