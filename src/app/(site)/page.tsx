import { experience, profile, skillGroups } from "@/content/profile";

const personJsonLd = {
  "@context": "https://schema.org",
  "@type": "Person",
  name: profile.name,
  jobTitle: profile.role,
  email: `mailto:${profile.email}`,
  worksFor: { "@type": "Organization", name: profile.company },
  address: { "@type": "PostalAddress", addressCountry: "TH" },
  sameAs: [profile.github, profile.linkedin].filter(Boolean),
};

export default function HomePage() {
  return (
    <div className="container">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />

      <section className="hero" aria-label="Introduction">
        <h1>{profile.name}</h1>
        <p className="role">
          {profile.role} · {profile.company}
        </p>
        <p className="tagline">{profile.tagline}</p>
        <div className="actions">
          <a className="button button-primary" href={`mailto:${profile.email}`}>
            Get in touch
          </a>
          <a className="button button-secondary" href="#experience">
            View experience
          </a>
        </div>
      </section>

      <section id="skills" aria-labelledby="skills-heading">
        <div className="section-head">
          <p className="section-label">Skills</p>
          <h2 id="skills-heading">What I work with</h2>
        </div>
        <div className="section-body">
          <div className="skill-groups">
            {skillGroups.map((group) => (
              <div className="skill-group" key={group.label}>
                <h3>{group.label}</h3>
                <ul className="chips">
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="experience" aria-labelledby="experience-heading">
        <div className="section-head">
          <p className="section-label">Experience</p>
          <h2 id="experience-heading">Where I&apos;ve worked</h2>
        </div>
        <div className="section-body">
          {experience.map((job) => (
            <article className="job" key={`${job.company}-${job.role}`}>
              <header>
                <h3>
                  {job.role} · <span className="company">{job.company}</span>
                </h3>
                <span className="period">{job.period}</span>
              </header>
              <p className="summary">{job.summary}</p>
              <ul>
                {job.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section id="about" aria-labelledby="about-heading">
        <div className="section-head">
          <p className="section-label">About</p>
          <h2 id="about-heading">A bit about me</h2>
        </div>
        <div className="section-body prose">
          {profile.about.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </section>

      <section id="contact" aria-labelledby="contact-heading">
        <div className="section-head">
          <p className="section-label">Contact</p>
          <h2 id="contact-heading">Let&apos;s talk</h2>
        </div>
        <div className="section-body prose">
          <p>
            The fastest way to reach me is email — I&apos;m open to interesting
            infrastructure and data platform problems.
          </p>
          <div className="contact-links">
            <a
              className="button button-primary"
              href={`mailto:${profile.email}`}
            >
              {profile.email}
            </a>
            {profile.github && (
              <a className="button button-secondary" href={profile.github}>
                GitHub
              </a>
            )}
            {profile.linkedin && (
              <a className="button button-secondary" href={profile.linkedin}>
                LinkedIn
              </a>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
