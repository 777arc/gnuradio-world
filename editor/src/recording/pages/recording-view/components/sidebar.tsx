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
      {/* Deliberately not a <details> and deliberately unframed: the settings are
          the viewer's primary controls, so they are always open with no
          disclosure triangle, header bar or outline around them. */}
      <div className="p-2">
        <SettingsPane currentFFT={currentFFT} currentTab={currentTab} setCurrentTab={setCurrentTab} />
      </div>
    </div>
  );
};

export { Sidebar };
