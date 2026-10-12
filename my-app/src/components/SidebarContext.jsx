import { createContext, useContext, useState } from "react";

const SidebarContext = createContext(null);

export function SidebarProvider({ children }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isPreview, setIsPreview] = useState(false);

  const toggle = () => {
    setIsCollapsed((value) => !value);
    setIsPreview(false);
  };
  const setPreview = (value) => setIsPreview(value);

  return (
    <SidebarContext.Provider value={{ isCollapsed, isPreview, toggle, setPreview }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
}
