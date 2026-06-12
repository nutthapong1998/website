import { profile } from "@/content/profile";
import { ThemeToggle } from "@/components/site/ThemeToggle";

export default function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <header className="site-header">
        <div className="container">
          <a className="brand" href="#top">
            {profile.name}
          </a>
          <div className="header-right">
            <nav aria-label="Main">
              <a href="#skills">Skills</a>
              <a href="#experience">Experience</a>
              <a href="#about">About</a>
              <a href="#contact">Contact</a>
            </nav>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="top">{children}</main>
      <footer className="site-footer">
        <div className="container">
          <span>
            © {new Date().getFullYear()} {profile.name}
          </span>
          <span>{profile.location}</span>
        </div>
      </footer>
    </>
  );
}
