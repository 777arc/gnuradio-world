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
      {/* Deliberately not a <details>: the settings are the viewer's primary
          controls, so the panel is always open and has no disclosure triangle. */}
      <div className="pl-2 bg-primary outline outline-1 outline-primary text-base-100">Settings</div>
      <div className="outline outline-1 outline-primary p-2">
        <SettingsPane currentFFT={currentFFT} currentTab={currentTab} setCurrentTab={setCurrentTab} />
      </div>
    </div>
  );
};

export { Sidebar };
