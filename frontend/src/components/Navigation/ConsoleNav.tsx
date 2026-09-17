import { Fragment, memo, useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Box, ButtonBase, Tab, Tabs, Typography } from '@mui/material';
import StorageIcon from '@mui/icons-material/Storage';
import MemoryIcon from '@mui/icons-material/Memory';
import HubIcon from '@mui/icons-material/Hub';
import TuneIcon from '@mui/icons-material/Tune';
import RuleIcon from '@mui/icons-material/Rule';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import type { Role } from '../../constants/roles';
import type { ManagerMode } from '../../store/appStore';
import { sectionOf, sectionsForRole, type SectionId, type VisibleSection } from './consoleSections';

/*
 * Two-level console header: sections on top, the active section's pages below.
 *
 * The active section is drawn as an open folder tab: it takes the page row's
 * surface colour and flows into it through two concave corners, so the pages
 * underneath read as belonging to it. Both rows sit in one grid, so page tabs
 * share a left edge with the section tabs regardless of the brand's width.
 */

// Translucent over the AppBar paper, so the active tab, its corners and the
// page row composite to exactly the same colour.
const PAGE_ROW_BG = 'rgba(255,255,255,0.05)';
const HAIRLINE = 'rgba(255,255,255,0.08)';
const MUTED = 'rgba(255,255,255,0.6)';
const HOVER = 'rgba(255,255,255,0.87)';
/** Radius of the folder tab's top corners and of the concave corners at its foot. */
const CORNER = 10;
const TOP_ROW = 52;
const PAGE_ROW = 40;

const SECTION_ICONS: Record<SectionId, ReactNode> = {
  database: <StorageIcon />,
  cache: <MemoryIcon />,
  clickhouse: <HubIcon />,
  configs: <TuneIcon />,
  requests: <RuleIcon />,
  admin: <AdminPanelSettingsIcon />,
};

const focusRing = {
  '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: '-2px' },
} as const;

const noMotion = { '@media (prefers-reduced-motion: reduce)': { transition: 'none' } } as const;

// Last page opened in each section, so returning to a section lands where the
// user left it. Session-scoped, like managerMode itself.
const LAST_PAGE_KEY = 'lastPageBySection';

const loadLastPages = (): Partial<Record<SectionId, ManagerMode>> => {
  try {
    return JSON.parse(sessionStorage.getItem(LAST_PAGE_KEY) || '{}');
  } catch {
    return {};
  }
};

const CountBadge = ({ count }: { count: number }) => (
  <Box
    component="span"
    aria-label={`${count} pending`}
    sx={{
      minWidth: 18,
      height: 18,
      px: 0.5,
      borderRadius: '9px',
      bgcolor: 'error.main',
      color: '#fff',
      fontSize: '0.65rem',
      fontWeight: 700,
      lineHeight: '18px',
      textAlign: 'center',
    }}
  >
    {count > 99 ? '99+' : count}
  </Box>
);

interface ConsoleNavProps {
  role: Role;
  managerMode: ManagerMode;
  onSelect: (mode: ManagerMode) => void;
  pendingApprovals: number;
  brand: string;
  /** Right end of the top row. */
  actions: ReactNode;
}

const ConsoleNav = ({ role, managerMode, onSelect, pendingApprovals, brand, actions }: ConsoleNavProps) => {
  const sections = useMemo(() => sectionsForRole(role), [role]);
  const activeId = sectionOf(managerMode);
  const activeSection = sections.find((s) => s.id === activeId);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastPages = useRef(loadLastPages());

  // Tracks every page change, including ones made outside the header (e.g.
  // Migrations jumping to DB Manager).
  useEffect(() => {
    lastPages.current = { ...lastPages.current, [sectionOf(managerMode)]: managerMode };
    try {
      sessionStorage.setItem(LAST_PAGE_KEY, JSON.stringify(lastPages.current));
    } catch {
      // Ignore storage errors
    }
  }, [managerMode]);

  const selectSection = (section: VisibleSection) => {
    if (section.id === activeId) return;
    const remembered = lastPages.current[section.id];
    const target = section.tabs.find((t) => t.mode === remembered) ?? section.tabs[0];
    onSelect(target.mode);
  };

  // Arrow keys move focus between sections; Enter/Space opens one.
  const handleSectionKeyDown = (e: KeyboardEvent, index: number) => {
    const last = sections.length - 1;
    const next =
      e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    tabRefs.current[next]?.focus();
  };

  const pageVisible = activeSection?.tabs.some((t) => t.mode === managerMode) ?? false;

  return (
    <Box
      component="nav"
      aria-label="Console"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr) auto', md: 'auto minmax(0, 1fr) auto' },
        gridTemplateRows: `${TOP_ROW}px ${PAGE_ROW}px`,
        gridTemplateAreas: {
          xs: '"sections actions" "pages pages"',
          md: '"brand sections actions" "gutter pages pages"',
        },
      }}
    >
      {/* Brand and actions share the tabs' band at the bottom of the top row, so all three line up. */}
      <Box sx={{ gridArea: 'brand', display: { xs: 'none', md: 'flex' }, alignItems: 'center', alignSelf: 'end', height: PAGE_ROW, pl: 3, pr: 2 }}>
        <Typography component="h1" noWrap sx={{ fontSize: '1rem', fontWeight: 600, letterSpacing: '-0.005em' }}>
          {brand}
        </Typography>
      </Box>

      {/* Sections */}
      <Box
        role="tablist"
        aria-label="Sections"
        sx={{
          gridArea: 'sections',
          display: 'flex',
          alignItems: 'flex-end',
          minWidth: 0,
          px: `${CORNER}px`,
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}
      >
        {sections.map((section, index) => {
          const active = section.id === activeId;
          return (
            <Fragment key={section.id}>
              {/* Admin is about the console itself, not a data store — set it apart. */}
              {section.id === 'admin' && index > 0 && (
                <Box
                  aria-hidden
                  // Centred on the tabs, which sit at the bottom of the taller top row.
                  sx={{ alignSelf: 'center', flexShrink: 0, width: '1px', height: 20, mt: `${TOP_ROW - PAGE_ROW}px`, mx: 1, bgcolor: HAIRLINE }}
                />
              )}
              <ButtonBase
                ref={(el: HTMLButtonElement | null) => { tabRefs.current[index] = el; }}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => selectSection(section)}
                onKeyDown={(e) => handleSectionKeyDown(e, index)}
                sx={{
                  position: 'relative',
                  flexShrink: 0,
                  height: PAGE_ROW,
                  px: '14px',
                  gap: 1,
                  borderRadius: `${CORNER}px ${CORNER}px 0 0`,
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  color: active ? '#fff' : MUTED,
                  bgcolor: active ? PAGE_ROW_BG : 'transparent',
                  transition: 'background-color 120ms ease, color 120ms ease',
                  ...noMotion,
                  '& .MuiSvgIcon-root': { fontSize: 18, color: active ? 'primary.main' : 'inherit' },
                  ...(active
                    ? {
                        '&::before, &::after': {
                          content: '""',
                          position: 'absolute',
                          bottom: 0,
                          width: CORNER,
                          height: CORNER,
                          pointerEvents: 'none',
                        },
                        '&::before': {
                          left: -CORNER,
                          background: `radial-gradient(circle at 0 0, transparent ${CORNER}px, ${PAGE_ROW_BG} ${CORNER + 0.5}px)`,
                        },
                        '&::after': {
                          right: -CORNER,
                          background: `radial-gradient(circle at 100% 0, transparent ${CORNER}px, ${PAGE_ROW_BG} ${CORNER + 0.5}px)`,
                        },
                      }
                    : { '&:hover': { color: HOVER, bgcolor: 'rgba(255,255,255,0.03)' } }),
                  ...focusRing,
                }}
              >
                {SECTION_ICONS[section.id]}
                {section.label}
                {section.id === 'requests' && pendingApprovals > 0 && <CountBadge count={pendingApprovals} />}
              </ButtonBase>
            </Fragment>
          );
        })}
      </Box>

      <Box sx={{ gridArea: 'actions', display: 'flex', alignItems: 'center', alignSelf: 'end', height: PAGE_ROW, gap: 1.5, pl: 1, pr: { xs: 2, md: 3 } }}>
        {actions}
      </Box>

      {/* Page row — always present, so switching sections never moves the content below. */}
      <Box sx={{ gridArea: 'gutter', display: { xs: 'none', md: 'block' }, bgcolor: PAGE_ROW_BG, borderBottom: `1px solid ${HAIRLINE}` }} />
      <Box
        sx={{
          gridArea: 'pages',
          minWidth: 0,
          display: 'flex',
          alignItems: 'stretch',
          pl: '12px',
          bgcolor: PAGE_ROW_BG,
          borderBottom: `1px solid ${HAIRLINE}`,
        }}
      >
        {activeSection && activeSection.tabs.length > 1 && (
          <Tabs
            value={pageVisible ? managerMode : false}
            onChange={(_e, mode: ManagerMode) => onSelect(mode)}
            variant="scrollable"
            scrollButtons={false}
            aria-label={`${activeSection.label} pages`}
            sx={{
              minHeight: PAGE_ROW,
              '& .MuiTabs-indicator': { height: 2, ...noMotion },
            }}
          >
            {activeSection.tabs.map((tab) => (
              <Tab
                key={tab.mode}
                value={tab.mode}
                label={tab.label}
                sx={{
                  minHeight: PAGE_ROW,
                  minWidth: 0,
                  px: 1.5,
                  py: 0,
                  textTransform: 'none',
                  fontSize: '0.8125rem',
                  fontWeight: 500,
                  color: MUTED,
                  '&:hover': { color: HOVER },
                  '&.Mui-selected': { color: '#fff' },
                  ...focusRing,
                }}
              />
            ))}
          </Tabs>
        )}
        {/* A lone page has nothing to switch to — name it instead of drawing a tab. */}
        {activeSection && activeSection.tabs.length === 1 && (
          <Typography
            aria-current="page"
            sx={{ alignSelf: 'center', px: 1.5, fontSize: '0.8125rem', fontWeight: 500, color: '#fff' }}
          >
            {activeSection.tabs[0].label}
          </Typography>
        )}
      </Box>
    </Box>
  );
};

export default memo(ConsoleNav);
