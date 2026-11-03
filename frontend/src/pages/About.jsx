// src/pages/About.jsx
// The About page. Edit the text here; the type treatment is in About.css.
import { COLOR_BRAND, COLOR_BRAND_DARK } from "../config";
import "./About.css";

export default function About() {
  return (
    <div
      className="about-page"
      style={{ "--about-brand-light": COLOR_BRAND, "--about-brand-dark": COLOR_BRAND_DARK }}
    >
      <article className="about-content">
        <header className="about-title">
          <h1 className="about-title-mark">UNI·CEN</h1>
          <p className="about-title-name">Canadian Census Observatory</p>
        </header>

        <p className="about-intro">
          The UNI·CEN Canadian Census Observatory is a research project that aims to make historical and recent Canadian census data more accessible and usable for researchers, policymakers, and the public. This platform provides interactive tools for exploring census data across different years and geographic levels, allowing users to analyze trends and patterns in population, demographics, and other key indicators.
        </p>

        <section>
          <h2>About the Data</h2>
          <p>
            The aggregate census data showcased here is derived from the Unified Infrastructure for Canadian Census Research (UNI·CEN) project, the goal of which is to reformat all available digital Canadian census data with consistent variable names, longitudinally consistent geographic linkages, and in a standardized tabular format. UNI·CEN combines data from multiple sources: The Canadian Peoples Project (1851–1921), The Canadian Century Research Infrastructure (1911–1951), born-digital Census data held by the University of Toronto's Map and Data Library (1961-1991), and data disseminated by Statistics Canada (1981-2021). Additional data was incorporated from digitization projects at the University of Western Ontario.</p>
          <p>
            With few exceptions, the data is presented at five geographic levels: census tracts (CTs) and census metropolitan areas (1951–2021), and census subdivisions (CSDs), census divisions (CDs), and provinces and territories (PRs) (1851–2021). As the goal is capture long-term change, more recently introduced geographic levels (e.g., enumeration areas, dissemination areas, and aggregate dissemination areas) are not included, although they could be in the future.</p>
          <p>
            The data is available for all census years from 1851 to 2021, with the exception of 1966 and 1971, for which only CT- and PR-level data are available. Census tracts and metropolitan areas data was first disseminated in 1951.
          </p>
        </section>

        <section>
          <h2>About the Boundaries</h2>
          <p>
            The geographic boundaries used in the UNI·CEN Canadian Census Observatory are derived from historical and recent sources: The Canadian Peoples Project (CSDs and CDs, 1851–1921), The Canadian Century Research Infrastructure (CSDs and CDs, 1911–1951), the Early Postwar Neighbourhood Change Project (CTs, 1951–1966), boundary files held by the University of Toronto's Map and Data Library (CTs, CSDs, and CDs, 1981–96),and Statistics Canada (CSDs, CDs, and CTs, 2001–2021). These boundaries, which were created using different techniques and at different times according different standards, have been standardized by clipping to common shorelines, simplifying vertices, and reprojecting to a common coordinate system. For use in the app, the boundaries were further simplified and insofar as possible polygon arcs were aligned to produce a compact cross-temporal topojson representation of the features. The boundary series are mostly complete, although some gaps remain. For example, census subdivision and census division boundaries for 1956, 1961, 1966, or 1976 have never been digitized. 
          </p>
        </section>

        <section>
          <h2>About the App</h2>
          <p>
            After experimenting with constructing a custom web application using the R/Shiny framework, we leveraged AI-assisted coding to build this app in Javascript using multiple frameworks. The app is hosted on a virtual machine provisioned by the Digital Research Alliance of Canada (DRAC).
          </p>
        </section>

        <section>
          <h2>Credits</h2>
          <p>
            The UNI·CEN project is an initiative of the University of Western Ontario’s Faculty of Social Science, led by Dr. Zack Taylor (Department of Political Science) in collaboration with Dr. Victoria Esses (Department of Psychology) and Dr. David Armstrong (Department of Political Science).</p>
          <p>
            We acknowledge the support of research assistants Brittany Bouteiller, Kyle Hendricks, Allan Hsu, and Alyssa McGinnis, as well work by Dr. Christopher Hewitt on the digitization of the 1951–1966 census tract boundaries. This project benefitted from the advice of map and data librarians associated with the Canadian Census Data Discovery Partnership, including Principal Investigator Leanne Trimble (University of Toronto Libraries) and Amber Leahey (ScholarsPortal).</p>
          <p>
            The basemap used in the UNI·CEN Canadian Census Observatory is provided by <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> and <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>, and the map is drawn with <a href="https://leafletjs.com/" target="_blank" rel="noreferrer">Leaflet</a>. The territorial extent of Canada in early years, and boundary disputes between provinces, is represented with reference to the <a href="https://doi.org/10.5683/SP2/IQ7E0X" target="_blank" rel="noreferrer">Historical Atlas of Canada, Territorial Evolution</a> (CC BY-NC 4.0).
          </p>

        </section>
      </article>
    </div>
  );
}
